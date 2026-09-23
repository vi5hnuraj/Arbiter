// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ERC20 interface (same as original ArbiterPaymentManager).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Minimal Chainlink AggregatorV3 interface.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * Arbiter Arbitrum Manager — settlement escrow for agent commerce on Arbitrum.
 *
 * Ported from ArbiterPaymentManager (Base Sepolia) for the Arbitrum Open House
 * Singapore Buildathon. Same escrow lifecycle (PENDING/HELD -> RELEASED/CANCELLED),
 * same ERC20 + native paths, so the existing Arbiter backend maps 1:1.
 *
 * NEW in this Buildathon version:
 *
 *   1. ⭐ Chainlink-priced USD settlement: services are priced in USD cents; the
 *      contract converts to USDC at the live Chainlink rate, with staleness and
 *      slippage guards.
 *
 *   2. ⭐ Review-window escrow with four endings (ERC20 path, pType == ESCROW):
 *         - approveDelivery:        buyer releases held funds to the provider
 *         - approveDeliveryPartial: buyer pays a share, the remainder auto-refunds
 *         - rejectDelivery:         buyer refunds itself before the deadline
 *         - autoResolve:            permissionless, after the deadline — delivered
 *                                   work is paid, undelivered work is refunded.
 *                                   Silence is never a veto for either side.
 *      A payout happens at most once: state flips before any transfer.
 *
 *   3. ⭐ Delivery evidence: markDelivered carries a content fingerprint
 *      (e.g. hash of the service output), which is also what Arbiter's proof
 *      layer anchors. Delivery is verifiable, not just asserted.
 *
 *   4. ⭐ Portable reputation: every resolution emits SettlementCompleted with the
 *      outcome and whether delivery was on time, so a provider's track record can
 *      be indexed from chain data alone.
 *
 * Design acknowledgements: review-window endings and partial release are inspired
 * by HeldEscrow (Held, ETHOnline 2026, Apache-2.0); delivery evidence, acceptance
 * windows and the punctuality signal are inspired by PactEscrow (Pact, ETHOnline
 * 2026, MIT). This implementation is original to Arbiter and combines them with
 * Chainlink USD pricing and delivery-gated auto-resolution.
 */
contract ArbiterManager {
    enum PaymentType { DIRECT, SCHEDULED, ESCROW, INVOICE, REQUEST }
    enum PaymentStatus { PENDING, HELD, RELEASED, CANCELLED }

    /// @notice How an ESCROW payment ended. Indexable reputation signal.
    enum Outcome { NONE, APPROVED, PARTIAL, REJECTED, AUTO_DELIVERED, AUTO_REFUNDED }

    struct Payment {
        PaymentType pType;
        PaymentStatus status;
        address sender;
        address receiver;
        address token;      // address(0) = native coin; otherwise ERC20
        uint256 amount;
        uint256 releaseTime;
        bytes32 invoiceRef;
        bool exists;
        // --- v2/v3 escrow fields (zero for legacy flows) ---
        uint256 deadline;   // review window end; 0 = no window
        bytes32 termsHash;  // hash of the agreed invoice terms
        bool delivered;     // provider marked the service as delivered
        uint256 deliveredAt; // timestamp of delivery (0 = not delivered)
        bytes32 evidenceHash; // content fingerprint committed by the provider
        bool fundedViaEngagement; // created through the B2B engagement flow
    }

    mapping(bytes32 => Payment) public payments;
    address public owner;

    // ---------------- B2B engagements (Pact-style: propose -> mutual accept -> fund) ----------------
    enum EngagementStatus { NONE, PROPOSED, ACCEPTED, FUNDED, SETTLED, CANCELLED }

    struct Engagement {
        EngagementStatus status;
        address client;       // proposes terms and funds the escrow
        address provider;     // must sign the identical termsHash before funding
        address token;        // settlement token (ERC20)
        uint256 usdCents;     // agreed price in USD cents (Chainlink-converted at funding)
        uint64 deadline;      // delivery deadline both parties committed to
        bytes32 termsHash;    // keccak256 of the canonical terms JSON — the "ENS-style" verifiable terms
        bool exists;
    }

    mapping(bytes32 => Engagement) public engagements;
    /// @notice Portable, platform-independent reputation: count of successfully
    ///         settled engagements per provider address (queryable by anyone).
    mapping(address => uint256) public engagementsCompleted;

    // ---------------- Chainlink USD pricing ----------------
    address public priceFeed;     // feed reporting USD price per 1 token, 8 decimals.
                                  // address(0) => treat 1 token == 1.00 USD (fallback for
                                  // chains without a USDC/USD feed).
    uint8 public tokenDecimals;   // decimals of the settlement token (USDC = 6)

    uint256 public maxFeedAge = 1 hours; // max feed staleness; adjustable per network
                                         // (Arbitrum Sepolia's official USDC/USD feed has a 24h
                                         // heartbeat, so testnet deployments set 25h)
    uint256 public constant FEED_PRECISION = 1e8; // Chainlink USD feeds use 8 decimals
    uint256 public constant MAX_REVIEW_WINDOW = 30 days;

    // ---------------- custom errors (gas-cheap, typed) ----------------
    error NotOwner();
    error BadDecimals();
    error ZeroPrice();
    error FeedError();
    error StaleFeed();
    error Slippage();
    error IDExists();
    error ZeroReceiver();
    error ZeroToken();
    error ZeroValue();
    error ZeroAddress();
    error BadWindow();
    error PastRelease();
    error TooEarly();
    error NotFound();
    error NotHeld();
    error NotEscrow();
    error UseEscrowEndings();
    error NotBuyer();
    error NotProvider();
    error NotDelivered();
    error AlreadyDelivered();
    error WindowOpen();
    error WindowClosed();
    error BadSplit();
    error TransferInFailed();
    error TransferFailed();
    error ReleaseFailed();
    error RefundFailed();
    error CannotCancel();

    // ---------------- B2B engagement errors (Pact-style mutual commitment) ----------------
    error EngagementExists();
    error NoEngagement();
    error AlreadyAccepted();
    error WrongProvider();
    error TermsMismatch();
    error NotProposed();
    error AlreadyFunded();
    error NotParty();

    // ---------------- events ----------------
    event PriceFeedUpdated(address indexed oldFeed, address indexed newFeed);
    event USDSettled(bytes32 indexed id, address indexed receiver, uint256 usdCents, int256 price, uint256 amount);
    event Delivered(bytes32 indexed id, address indexed provider, bytes32 evidenceHash, uint256 at);
    event DeliveryApproved(bytes32 indexed id, address indexed by, uint256 toProvider, uint256 toBuyer);
    event DeliveryRejected(bytes32 indexed id, address indexed by, uint256 refund);
    event AutoResolved(bytes32 indexed id, Outcome outcome, uint256 at);
    event SettlementCompleted(bytes32 indexed id, address indexed sender, address indexed receiver, uint256 amount, address token, Outcome outcome, bool onTime);

    event PaymentCreated(bytes32 indexed id, PaymentType indexed pType, address indexed sender, address receiver, uint256 amount, uint256 releaseTime);
    event PaymentReleased(bytes32 indexed id);
    event PaymentCancelled(bytes32 indexed id, uint256 refundAmount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------- B2B engagement events (portable track record) ----------------
    event EngagementProposed(bytes32 indexed id, address indexed client, address indexed provider, bytes32 termsHash, uint256 usdCents, uint256 deadline);
    event EngagementAccepted(bytes32 indexed id, address indexed provider, bytes32 termsHash, uint256 at);
    event EngagementFunded(bytes32 indexed id, address indexed client, uint256 amount, int256 price);
    event EngagementCancelled(bytes32 indexed id, address indexed by);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @param _priceFeed     Chainlink aggregator reporting USD per 1 settlement token
     *                       (8 decimals), or address(0) for the fixed 1.0 fallback.
     * @param _tokenDecimals Decimals of the settlement token (USDC = 6).
     */
    constructor(address _priceFeed, uint8 _tokenDecimals) {
        if (_tokenDecimals < 2) revert BadDecimals();
        priceFeed = _priceFeed;
        tokenDecimals = _tokenDecimals;
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setPriceFeed(address _priceFeed) external onlyOwner {
        emit PriceFeedUpdated(priceFeed, _priceFeed);
        priceFeed = _priceFeed;
    }

    function setMaxFeedAge(uint256 _maxFeedAge) external onlyOwner {
        require(_maxFeedAge >= 5 minutes, "Too strict");
        maxFeedAge = _maxFeedAge;
    }

    /**
     * @notice Convert a USD price (in cents, 2 decimals) into settlement-token units
     *         at the live Chainlink rate. Reverts on stale or broken feeds.
     * @return amount Token units to charge.
     * @return price  Raw feed answer (8 decimals), or 1e8 in fallback mode.
     */
    function quoteUSD(uint256 usdCents) public view returns (uint256 amount, int256 price) {
        if (usdCents == 0) revert ZeroPrice();
        if (priceFeed == address(0)) {
            return (usdCents * (10 ** (tokenDecimals - 2)), int256(1e8));
        }
        (, int256 answer_, , uint256 updatedAt, ) = AggregatorV3Interface(priceFeed).latestRoundData();
        price = answer_;
        if (price <= 0) revert FeedError();
        if (block.timestamp - updatedAt > maxFeedAge) revert StaleFeed();
        // usdCents(2dp) -> USD -> tokens: usdCents * 10^(decimals-2) * 1e8 / price
        amount = (usdCents * (10 ** (tokenDecimals - 2)) * FEED_PRECISION) / uint256(price);
    }

    // ---------------- review-window escrow for USD-priced invoices ----------------

    /**
     * @notice Settle a USD-priced invoice into a review-window escrow. The Chainlink
     *         rate converts `usdCents` to `token`; `maxAmount` is the payer's slippage
     *         cap. The provider calls markDelivered(id, evidenceHash) once the service
     *         is delivered; the buyer then approves, partially approves or rejects
     *         before the deadline, and anyone may call autoResolve afterwards.
     * @param termsHash    hash of the invoice terms both sides agreed on (off-chain JSON)
     * @param reviewWindow seconds the buyer has to decide (1 second .. 30 days)
     */
    function settleInvoiceUSDEscrow(
        bytes32 id,
        address receiver,
        bytes32 invoiceRef,
        address token,
        uint256 usdCents,
        uint256 maxAmount,
        bytes32 termsHash,
        uint256 reviewWindow
    ) external {
        if (reviewWindow == 0 || reviewWindow > MAX_REVIEW_WINDOW) revert BadWindow();
        (uint256 amount, int256 price) = quoteUSD(usdCents);
        if (amount == 0 || amount > maxAmount) revert Slippage();
        if (payments[id].exists) revert IDExists();
        if (receiver == address(0)) revert ZeroReceiver();
        if (token == address(0)) revert ZeroToken();

        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferInFailed();

        payments[id] = Payment({
            pType: PaymentType.ESCROW,
            status: PaymentStatus.HELD,
            sender: msg.sender,
            receiver: receiver,
            token: token,
            amount: amount,
            releaseTime: 0,
            invoiceRef: invoiceRef,
            exists: true,
            deadline: block.timestamp + reviewWindow,
            termsHash: termsHash,
            delivered: false,
            deliveredAt: 0,
            evidenceHash: bytes32(0),
            fundedViaEngagement: false
        });

        emit PaymentCreated(id, PaymentType.ESCROW, msg.sender, receiver, amount, 0);
        emit USDSettled(id, receiver, usdCents, price, amount);
    }

    /// @notice Provider confirms delivery and commits a content fingerprint
    ///         (e.g. keccak256 of the service output — the same value Arbiter's
    ///         proof layer anchors). Starts the buyer's review clock.
    function markDelivered(bytes32 id, bytes32 evidenceHash) external {
        Payment storage p = payments[id];
        if (!p.exists) revert NotFound();
        if (p.status != PaymentStatus.HELD) revert NotHeld();
        if (p.pType != PaymentType.ESCROW) revert NotEscrow();
        if (msg.sender != p.receiver) revert NotProvider();
        if (p.delivered) revert AlreadyDelivered();
        p.delivered = true;
        p.deliveredAt = block.timestamp;
        p.evidenceHash = evidenceHash;
        emit Delivered(id, msg.sender, evidenceHash, block.timestamp);
    }

    /// @notice Buyer approves delivered work: held funds go to the provider.
    function approveDelivery(bytes32 id) external {
        Payment storage p = _loadHeldEscrow(id);
        if (msg.sender != p.sender) revert NotBuyer();
        if (!p.delivered) revert NotDelivered();
        uint256 toProvider = p.amount; // capture BEFORE _resolveEscrow zeroes it
        _resolveEscrow(id, p, Outcome.APPROVED, p.receiver, toProvider);
        emit DeliveryApproved(id, msg.sender, toProvider, 0);
    }

    /// @notice Buyer approves part of the delivered work: `toProvider` goes to the
    ///         provider and the remainder auto-refunds the buyer. Real disputes are
    ///         rarely all-or-nothing. Requires delivery.
    function approveDeliveryPartial(bytes32 id, uint256 toProvider) external {
        Payment storage p = _loadHeldEscrow(id);
        if (msg.sender != p.sender) revert NotBuyer();
        if (!p.delivered) revert NotDelivered();
        if (toProvider > p.amount) revert BadSplit();
        uint256 toBuyer = p.amount - toProvider; // capture BEFORE the state flip
        _resolveEscrow(id, p, Outcome.PARTIAL, p.receiver, toProvider);
        emit DeliveryApproved(id, msg.sender, toProvider, toBuyer);
    }

    /// @notice Buyer rejects before the deadline: full refund to the buyer.
    function rejectDelivery(bytes32 id) external {
        Payment storage p = _loadHeldEscrow(id);
        if (msg.sender != p.sender) revert NotBuyer();
        if (block.timestamp >= p.deadline) revert WindowClosed();
        _resolveEscrow(id, p, Outcome.REJECTED, p.sender, p.amount);
        emit DeliveryRejected(id, msg.sender, p.amount);
    }

    /// @notice Permissionless resolution after the deadline. Delivered work is paid
    ///         to the provider; undelivered work is refunded to the buyer. No party
    ///         can trap the funds by going quiet, and no undelivered invoice can be
    ///         force-paid.
    function autoResolve(bytes32 id) external {
        Payment storage p = _loadHeldEscrow(id);
        if (block.timestamp < p.deadline) revert WindowOpen();
        if (p.delivered) {
            _resolveEscrow(id, p, Outcome.AUTO_DELIVERED, p.receiver, p.amount);
        } else {
            _resolveEscrow(id, p, Outcome.AUTO_REFUNDED, p.sender, p.amount);
        }
        emit AutoResolved(id, p.delivered ? Outcome.AUTO_DELIVERED : Outcome.AUTO_REFUNDED, block.timestamp);
    }

    /// @dev Loads a payment that can still be resolved.
    function _loadHeldEscrow(bytes32 id) private view returns (Payment storage p) {
        p = payments[id];
        if (!p.exists) revert NotFound();
        if (p.status != PaymentStatus.HELD) revert NotHeld();
        if (p.pType != PaymentType.ESCROW) revert NotEscrow();
    }

    /// @dev Single payout gate: flips state and zeroes the amount BEFORE any
    ///      transfer, so a payment can never resolve twice however the recipient
    ///      behaves on receipt. `toPayee + refund == held amount` always conserves.
    function _resolveEscrow(bytes32 id, Payment storage p, Outcome outcome, address payee, uint256 toPayee) internal {
        uint256 amount = p.amount;
        uint256 refund = amount - toPayee;
        p.status = (outcome == Outcome.APPROVED || outcome == Outcome.AUTO_DELIVERED)
            ? PaymentStatus.RELEASED
            : PaymentStatus.CANCELLED;
        p.amount = 0;
        bool onTime = p.deliveredAt != 0 && p.deliveredAt <= p.deadline;

        // Portable reputation: successful engagement settlements count toward
        // the provider's permanent on-chain track record.
        if (p.fundedViaEngagement && (outcome == Outcome.APPROVED || outcome == Outcome.PARTIAL || outcome == Outcome.AUTO_DELIVERED)) {
            engagementsCompleted[p.receiver] += 1;
        }

        emit PaymentReleased(id);
        if (toPayee > 0) {
            if (!IERC20(p.token).transfer(payee, toPayee)) revert TransferFailed();
        }
        if (refund > 0) {
            if (!IERC20(p.token).transfer(p.sender, refund)) revert TransferFailed();
        }
        emit SettlementCompleted(id, p.sender, p.receiver, amount, p.token, outcome, onTime);
    }

    // ================= B2B ENGAGEMENTS (Pact-style mutual commitment) =================
    //
    // Pact's thesis, implemented natively for agent commerce:
    //   ① PROPOSE  — client commits exact terms (hash) + names the provider.
    //                No money moves yet.
    //   ② ACCEPT   — provider signs the IDENTICAL termsHash. Commitment is now
    //                mutual: neither side can quietly change the deal.
    //   ③ FUND     — only after both signatures does the client's USDC enter the
    //                same review-window escrow used by single-shot invoices.
    //   ④ DELIVER  — provider calls markDelivered(id, evidenceHash).
    //   ⑤ SETTLE   — approve / partial / reject / autoResolve (four endings).
    //
    // The termsHash is the verifiable-terms anchor: both parties publish the
    // canonical terms JSON (IPFS/ENS text record/their own infra) and its hash
    // is what the chain enforces. Two signatures over one hash = no disputes
    // about what was agreed.

    /**
     * @notice Client proposes an engagement with exact terms. Off-chain, both
     *         parties can verify the canonical terms behind `termsHash` from a
     *         public location (ENS text record, IPFS, etc.) before signing.
     */
    function proposeEngagement(
        bytes32 id,
        address provider,
        address token,
        uint256 usdCents,
        uint64 deadline,
        bytes32 termsHash
    ) external {
        if (engagements[id].exists || payments[id].exists) revert EngagementExists();
        if (provider == address(0) || provider == msg.sender) revert ZeroAddress();
        if (token == address(0)) revert ZeroToken();
        if (usdCents == 0) revert ZeroPrice();
        if (termsHash == bytes32(0)) revert ZeroValue();
        if (deadline != 0 && deadline <= block.timestamp) revert BadWindow();

        engagements[id] = Engagement({
            status: EngagementStatus.PROPOSED,
            client: msg.sender,
            provider: provider,
            token: token,
            usdCents: usdCents,
            deadline: deadline,
            termsHash: termsHash,
            exists: true
        });
        emit EngagementProposed(id, msg.sender, provider, termsHash, usdCents, deadline);
    }

    /**
     * @notice The named provider signs the IDENTICAL terms hash. Commitment is
     *         now mutual — work can begin with the guarantee that funding is
     *         one transaction away and the terms cannot change underneath it.
     */
    function acceptEngagement(bytes32 id, bytes32 termsHash) external {
        Engagement storage e = engagements[id];
        if (!e.exists) revert NoEngagement();
        if (e.status != EngagementStatus.PROPOSED) revert NotProposed();
        if (msg.sender != e.provider) revert WrongProvider();
        if (termsHash != e.termsHash) revert TermsMismatch();
        e.status = EngagementStatus.ACCEPTED;
        emit EngagementAccepted(id, msg.sender, e.termsHash, block.timestamp);
    }

    /**
     * @notice Client funds the mutually-accepted engagement: the USD price is
     *         converted at the live Chainlink rate and locked in review-window
     *         escrow (same mechanics and endings as single-shot invoices).
     *         The engagement id doubles as the escrow payment id.
     */
    function fundEngagement(bytes32 id, uint256 maxAmount, uint256 reviewWindow) external {
        Engagement storage e = engagements[id];
        if (!e.exists) revert NoEngagement();
        if (e.status != EngagementStatus.ACCEPTED) revert NotProposed();
        if (msg.sender != e.client) revert NotBuyer();
        if (reviewWindow == 0 || reviewWindow > MAX_REVIEW_WINDOW) revert BadWindow();

        (uint256 amount, int256 price) = quoteUSD(e.usdCents);
        if (amount == 0 || amount > maxAmount) revert Slippage();

        if (!IERC20(e.token).transferFrom(msg.sender, address(this), amount)) revert TransferInFailed();

        payments[id] = Payment({
            pType: PaymentType.ESCROW,
            status: PaymentStatus.HELD,
            sender: e.client,
            receiver: e.provider,
            token: e.token,
            amount: amount,
            releaseTime: 0,
            invoiceRef: e.termsHash,
            exists: true,
            deadline: block.timestamp + reviewWindow,
            termsHash: e.termsHash,
            fundedViaEngagement: true,
            delivered: false,
            deliveredAt: 0,
            evidenceHash: bytes32(0)
        });
        e.status = EngagementStatus.FUNDED;
        emit PaymentCreated(id, PaymentType.ESCROW, e.client, e.provider, amount, 0);
        emit USDSettled(id, e.provider, e.usdCents, price, amount);
        emit EngagementFunded(id, e.client, amount, price);
    }

    /// @notice Client cancels a proposal or accepted (not yet funded) engagement.
    ///         Funded engagements follow the escrow endings instead.
    function cancelEngagement(bytes32 id) external {
        Engagement storage e = engagements[id];
        if (!e.exists) revert NoEngagement();
        if (e.status != EngagementStatus.PROPOSED && e.status != EngagementStatus.ACCEPTED) revert NotProposed();
        if (msg.sender != e.client && msg.sender != e.provider) revert NotParty();
        e.status = EngagementStatus.CANCELLED;
        emit EngagementCancelled(id, msg.sender);
    }

    /// @notice Full engagement state for UIs and indexers.
    function getEngagement(bytes32 id)
        external
        view
        returns (
            EngagementStatus status,
            address client,
            address provider,
            address token,
            uint256 usdCents,
            uint64 deadline,
            bytes32 termsHash,
            bool funded
        )
    {
        Engagement memory e = engagements[id];
        if (!e.exists) revert NoEngagement();
        return (e.status, e.client, e.provider, e.token, e.usdCents, e.deadline, e.termsHash, payments[id].exists);
    }

    // ---------------- original ERC20 path (immediate-release invoices) ----------------

    function settleInvoiceUSD(
        bytes32 id,
        address receiver,
        bytes32 invoiceRef,
        address token,
        uint256 usdCents,
        uint256 maxAmount
    ) external {
        (uint256 amount, int256 price) = quoteUSD(usdCents);
        if (amount == 0 || amount > maxAmount) revert Slippage();
        if (payments[id].exists) revert IDExists();
        if (receiver == address(0)) revert ZeroReceiver();
        if (token == address(0)) revert ZeroToken();

        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferInFailed();

        payments[id] = Payment({
            pType: PaymentType.INVOICE,
            status: PaymentStatus.HELD,
            sender: msg.sender,
            receiver: receiver,
            token: token,
            amount: amount,
            releaseTime: 0,
            invoiceRef: invoiceRef,
            exists: true,
            deadline: 0,
            termsHash: bytes32(0),
            delivered: false,
            deliveredAt: 0,
            evidenceHash: bytes32(0),
            fundedViaEngagement: false
        });

        emit PaymentCreated(id, PaymentType.INVOICE, msg.sender, receiver, amount, 0);
        emit USDSettled(id, receiver, usdCents, price, amount);
    }

    function settleInvoiceToken(bytes32 id, address receiver, bytes32 invoiceRef, address token, uint256 amount) external {
        if (payments[id].exists) revert IDExists();
        if (receiver == address(0)) revert ZeroReceiver();
        if (token == address(0)) revert ZeroToken();
        if (amount == 0) revert ZeroValue();
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferInFailed();
        payments[id] = Payment({
            pType: PaymentType.INVOICE,
            status: PaymentStatus.HELD,
            sender: msg.sender,
            receiver: receiver,
            token: token,
            amount: amount,
            releaseTime: 0,
            invoiceRef: invoiceRef,
            exists: true,
            deadline: 0,
            termsHash: bytes32(0),
            delivered: false,
            deliveredAt: 0,
            evidenceHash: bytes32(0),
            fundedViaEngagement: false
        });
        emit PaymentCreated(id, PaymentType.INVOICE, msg.sender, receiver, amount, 0);
    }

    function releaseToken(bytes32 id) external {
        Payment storage p = payments[id];
        if (!p.exists) revert NotFound();
        if (p.status != PaymentStatus.HELD) revert NotHeld();
        if (p.token == address(0)) revert NotEscrow();
        if (p.pType != PaymentType.INVOICE) revert UseEscrowEndings();
        p.status = PaymentStatus.RELEASED;
        uint256 amount = p.amount;
        p.amount = 0;
        if (!IERC20(p.token).transfer(p.receiver, amount)) revert ReleaseFailed();
        emit PaymentReleased(id);
    }

    // ---------------- original native-coin path ----------------

    function _create(bytes32 id, PaymentType pType, address receiver, uint256 releaseTime, bytes32 invoiceRef) internal {
        if (payments[id].exists) revert IDExists();
        if (receiver == address(0)) revert ZeroReceiver();
        if (msg.value == 0) revert ZeroValue();
        if (pType == PaymentType.SCHEDULED && releaseTime <= block.timestamp) revert PastRelease();
        payments[id] = Payment({
            pType: pType,
            status: PaymentStatus.HELD,
            sender: msg.sender,
            receiver: receiver,
            token: address(0),
            amount: msg.value,
            releaseTime: releaseTime,
            invoiceRef: invoiceRef,
            exists: true,
            deadline: 0,
            termsHash: bytes32(0),
            delivered: false,
            deliveredAt: 0,
            evidenceHash: bytes32(0),
            fundedViaEngagement: false
        });
        emit PaymentCreated(id, pType, msg.sender, receiver, msg.value, releaseTime);
    }

    function createDirect(bytes32 id, address receiver) external payable {
        _create(id, PaymentType.DIRECT, receiver, 0, bytes32(0));
    }

    function createScheduled(bytes32 id, address receiver, uint256 releaseTime) external payable {
        _create(id, PaymentType.SCHEDULED, receiver, releaseTime, bytes32(0));
    }

    function createEscrow(bytes32 id, address receiver) external payable {
        _create(id, PaymentType.ESCROW, receiver, 0, bytes32(0));
    }

    function settleInvoice(bytes32 id, address receiver, bytes32 invoiceRef) external payable {
        _create(id, PaymentType.INVOICE, receiver, 0, invoiceRef);
    }

    function settleRequest(bytes32 id, address receiver) external payable {
        _create(id, PaymentType.REQUEST, receiver, 0, bytes32(0));
    }

    // ---------------- lifecycle (native path) ----------------

    function release(bytes32 id) external {
        Payment storage p = payments[id];
        if (!p.exists) revert NotFound();
        if (p.status != PaymentStatus.HELD) revert NotHeld();
        if (p.pType == PaymentType.SCHEDULED && block.timestamp < p.releaseTime) revert TooEarly();
        p.status = PaymentStatus.RELEASED;
        (bool sent, ) = payable(p.receiver).call{value: p.amount}("");
        if (!sent) revert ReleaseFailed();
        emit PaymentReleased(id);
    }

    function cancel(bytes32 id) external {
        Payment storage p = payments[id];
        if (!p.exists) revert NotFound();
        if (p.status != PaymentStatus.HELD) revert NotHeld();
        if (p.pType == PaymentType.INVOICE || p.pType == PaymentType.REQUEST) revert CannotCancel();
        if (msg.sender != p.sender) revert NotBuyer();
        p.status = PaymentStatus.CANCELLED;
        (bool sent, ) = payable(p.sender).call{value: p.amount}("");
        if (!sent) revert RefundFailed();
        emit PaymentCancelled(id, p.amount);
    }

    function getPayment(bytes32 id)
        external
        view
        returns (
            PaymentType,
            PaymentStatus,
            address,
            address,
            address,
            uint256,
            uint256,
            bytes32,
            uint256,
            bytes32,
            bool,
            uint256,
            bytes32
        )
    {
        Payment memory p = payments[id];
        if (!p.exists) revert NotFound();
        return (
            p.pType, p.status, p.sender, p.receiver, p.token, p.amount, p.releaseTime,
            p.invoiceRef, p.deadline, p.termsHash, p.delivered, p.deliveredAt, p.evidenceHash
        );
    }
}
