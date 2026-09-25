const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ArbiterManager", function () {
  let manager, token, feed, consumer, provider, bystander;

  beforeEach(async () => {
    [, consumer, provider, bystander] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const Feed = await ethers.getContractFactory("MockFeed");
    token = await Token.deploy();
    feed = await Feed.deploy();
    const M = await ethers.getContractFactory("ArbiterManager");
    manager = await M.deploy(await feed.getAddress(), 6);
    await token.transfer(consumer.address, 1000e6);
  });

  // ---------------- pricing ----------------

  it("fallback mode: $1.00 quotes 1 USDC", async () => {
    const M2 = await ethers.getContractFactory("ArbiterManager");
    const m2 = await M2.deploy(ethers.ZeroAddress, 6);
    const [amount, price] = await m2.quoteUSD(100);
    expect(amount).to.equal(1_000_000n);
    expect(price).to.equal(1e8);
  });

  it("chainlink mode: $1.00 at price 1.0005 -> 0.9995 USDC (floor)", async () => {
    await feed.setPrice(100050000n);
    const [amount] = await manager.quoteUSD(100);
    expect(amount).to.equal(999_500n);
  });

  // ---------------- immediate invoice flow ----------------

  it("full flow: quote -> approve -> settleInvoiceUSD -> releaseToken", async () => {
    await feed.setPrice(1e8);
    const [amount] = await manager.quoteUSD(100);

    await token.connect(consumer).approve(await manager.getAddress(), amount * 2n);
    const id = ethers.id("test-invoice-1");
    const ref = ethers.id("invoice-ref");

    await expect(
      manager.connect(consumer).settleInvoiceUSD(id, provider.address, ref, await token.getAddress(), 100, amount * 2n)
    ).to.emit(manager, "USDSettled");

    const p = await manager.getPayment(id);
    expect(p[1]).to.equal(1n); // HELD
    expect(p[5]).to.equal(amount);

    await manager.releaseToken(id);
    const p2 = await manager.getPayment(id);
    expect(p2[1]).to.equal(2n); // RELEASED
    expect(await token.balanceOf(provider.address)).to.equal(amount);
  });

  it("slippage guard: maxAmount too low reverts with Slippage", async () => {
    await token.connect(consumer).approve(await manager.getAddress(), ethers.MaxUint256);
    const id = ethers.id("test-invoice-2");
    await expect(
      manager.connect(consumer).settleInvoiceUSD(id, provider.address, ethers.id("r"), await token.getAddress(), 100, 1)
    ).to.be.revertedWithCustomError(manager, "Slippage");
  });

  it("duplicate id reverts with IDExists", async () => {
    await token.connect(consumer).approve(await manager.getAddress(), ethers.MaxUint256);
    const id = ethers.id("test-invoice-3");
    await manager.connect(consumer).settleInvoiceUSD(id, provider.address, ethers.id("r"), await token.getAddress(), 100, ethers.MaxUint256);
    await expect(
      manager.connect(consumer).settleInvoiceUSD(id, provider.address, ethers.id("r2"), await token.getAddress(), 100, ethers.MaxUint256)
    ).to.be.revertedWithCustomError(manager, "IDExists");
  });

  // ---------------- review-window escrow: four endings ----------------

  async function openEscrow(reviewWindow = 3600) {
    await feed.setPrice(1e8);
    await token.connect(consumer).approve(await manager.getAddress(), ethers.MaxUint256);
    const id = ethers.id(`escrow-${Math.random()}`);
    await manager
      .connect(consumer)
      .settleInvoiceUSDEscrow(id, provider.address, ethers.id("ref"), await token.getAddress(), 100, 2e6, ethers.id("terms"), reviewWindow);
    return id;
  }

  async function deliver(id) {
    const evidence = ethers.id("service-output-ocr-result");
    await manager.connect(provider).markDelivered(id, evidence);
    const p = await manager.getPayment(id);
    expect(p[12]).to.equal(evidence); // evidenceHash committed on-chain
  }

  it("ending 1: delivered -> buyer approves -> provider paid, onTime=true", async () => {
    const id = await openEscrow();
    await deliver(id);
    await expect(manager.connect(consumer).approveDelivery(id))
      .to.emit(manager, "SettlementCompleted")
      .withArgs(id, consumer.address, provider.address, 1_000_000n, await token.getAddress(), 1n, true);

    const p = await manager.getPayment(id);
    expect(p[1]).to.equal(2n); // RELEASED
    expect(await token.balanceOf(provider.address)).to.equal(1_000_000n);
    expect(await token.balanceOf(await manager.getAddress())).to.equal(0n); // nothing stranded
  });

  it("ending 2 (partial): buyer pays 60%, remainder auto-refunds", async () => {
    const id = await openEscrow();
    await deliver(id);
    await manager.connect(consumer).approveDeliveryPartial(id, 600_000n);

    const p = await manager.getPayment(id);
    expect(p[1]).to.equal(3n); // CANCELLED (partially resolved)
    expect(await token.balanceOf(provider.address)).to.equal(600_000n);
    expect(await token.balanceOf(consumer.address)).to.equal(999_400_000n); // 1000e6 - 1e6 paid + 400_000 refunded
    expect(await token.balanceOf(await manager.getAddress())).to.equal(0n);
  });

  it("ending 3: buyer rejects UNDELIVERED work before deadline -> full refund", async () => {
    const id = await openEscrow();
    // no deliver() — service never arrived
    await manager.connect(consumer).rejectDelivery(id);

    const p = await manager.getPayment(id);
    expect(p[1]).to.equal(3n); // CANCELLED
    expect(await token.balanceOf(consumer.address)).to.equal(1000e6);
  });

  it("security: delivered work can never be rejected (use-then-refund blocked)", async () => {
    const id = await openEscrow();
    await deliver(id); // buyer has already received the goods
    await expect(manager.connect(consumer).rejectDelivery(id))
      .to.be.revertedWithCustomError(manager, "AlreadyDelivered");
    // escrow still HELD — provider's delivery proof stands; only approve/split/deadline remain
    const p = await manager.getPayment(id);
    expect(p[1]).to.equal(1n);
    expect(await token.balanceOf(consumer.address)).to.equal(999_000_000n); // no refund
  });

  it("security: partial split cannot zero the provider (25% floor)", async () => {
    const id = await openEscrow();
    await deliver(id);
    // 249_999 = 24.9999% < 25% floor -> BadSplit
    await expect(manager.connect(consumer).approveDeliveryPartial(id, 249_999n))
      .to.be.revertedWithCustomError(manager, "BadSplit");
    // exactly 25% passes
    await manager.connect(consumer).approveDeliveryPartial(id, 250_000n);
    expect(await token.balanceOf(provider.address)).to.equal(250_000n);
  });

  it("ending 4a: delivered + silence -> ANYONE auto-resolves, provider paid", async () => {
    const id = await openEscrow(60);
    await deliver(id);
    await time.increase(61);
    await manager.connect(bystander).autoResolve(id); // permissionless

    const p = await manager.getPayment(id);
    expect(p[1]).to.equal(2n);
    expect(await token.balanceOf(provider.address)).to.equal(1_000_000n);
  });

  it("ending 4b: undelivered + silence -> ANYONE auto-resolves, buyer refunded", async () => {
    const id = await openEscrow(60);
    await time.increase(61);
    await manager.connect(bystander).autoResolve(id);

    const p = await manager.getPayment(id);
    expect(p[1]).to.equal(3n); // CANCELLED (refund)
    expect(await token.balanceOf(consumer.address)).to.equal(1000e6);
  });

  it("deadline edges: autoResolve too early reverts; reject too late reverts", async () => {
    const id = await openEscrow(60);
    await deliver(id);
    await expect(manager.connect(consumer).autoResolve(id)).to.be.revertedWithCustomError(manager, "WindowOpen");
    await time.increase(61);
    await expect(manager.connect(consumer).rejectDelivery(id)).to.be.revertedWithCustomError(manager, "WindowClosed"); // WindowClosed checked before AlreadyDelivered
    await manager.connect(bystander).autoResolve(id);
  });

  it("reject too late while undelivered also reverts", async () => {
    const id = await openEscrow(60);
    await time.increase(61);
    await expect(manager.connect(consumer).rejectDelivery(id)).to.be.revertedWithCustomError(manager, "WindowClosed");
  });

  it("approve without delivery reverts with NotDelivered", async () => {
    const id = await openEscrow();
    await expect(manager.connect(consumer).approveDelivery(id)).to.be.revertedWithCustomError(manager, "NotDelivered");
  });

  it("double payout impossible after any ending", async () => {
    const id = await openEscrow();
    await deliver(id);
    await manager.connect(consumer).approveDelivery(id);
    await expect(manager.connect(consumer).approveDelivery(id)).to.be.revertedWithCustomError(manager, "NotHeld");
    await expect(manager.connect(provider).markDelivered(id, ethers.id("x"))).to.be.revertedWithCustomError(manager, "NotHeld");
    await expect(manager.connect(bystander).autoResolve(id)).to.be.revertedWithCustomError(manager, "NotHeld");
  });

  it("only the provider can mark delivered; only the buyer decides", async () => {
    const id = await openEscrow();
    await expect(manager.connect(bystander).markDelivered(id, ethers.id("x"))).to.be.revertedWithCustomError(manager, "NotProvider");
    await manager.connect(provider).markDelivered(id, ethers.id("x"));
    await expect(manager.connect(bystander).approveDelivery(id)).to.be.revertedWithCustomError(manager, "NotBuyer");
  });

  it("partial split cannot exceed the held amount", async () => {
    const id = await openEscrow();
    await deliver(id);
    await expect(manager.connect(consumer).approveDeliveryPartial(id, 2_000_000n)).to.be.revertedWithCustomError(manager, "BadSplit");
  });

  it("escrow rejects bad review window", async () => {
    await token.connect(consumer).approve(await manager.getAddress(), ethers.MaxUint256);
    const id = ethers.id("bad-window");
    await expect(
      manager.connect(consumer).settleInvoiceUSDEscrow(id, provider.address, ethers.id("ref"), await token.getAddress(), 100, 2e6, ethers.id("terms"), 0)
    ).to.be.revertedWithCustomError(manager, "BadWindow");
  });

  // ---------------- B2B engagements (Pact-style mutual commitment) ----------------

  const propose = async (id, termsHash) =>
    manager.connect(consumer).proposeEngagement(
      id, provider.address, await token.getAddress(), 500, // $5.00
      0, // no explicit delivery deadline (deadline for review window comes at funding)
      termsHash
    );

  const acceptAndFund = async (id, termsHash) => {
    await propose(id, termsHash);
    await manager.connect(provider).acceptEngagement(id, termsHash);
    await token.connect(consumer).approve(await manager.getAddress(), ethers.MaxUint256);
    await manager.connect(consumer).fundEngagement(id, 10e6, 3600);
  };

  it("B2B flow: propose -> accept(same terms) -> fund -> deliver -> approve", async () => {
    const id = ethers.id("b2b-1");
    const terms = ethers.id("terms-json-canonical");
    await feed.setPrice(1e8);

    await expect(propose(id, terms))
      .to.emit(manager, "EngagementProposed").withArgs(id, consumer.address, provider.address, terms, 500n, 0n);
    const [, eClient, eProvider, , eUsd, , eTerms] = await manager.getEngagement(id);
    expect(eClient).to.equal(consumer.address);
    expect(eProvider).to.equal(provider.address);
    expect(eUsd).to.equal(500n);
    expect(eTerms).to.equal(terms);

    await expect(manager.connect(provider).acceptEngagement(id, terms))
      .to.emit(manager, "EngagementAccepted");

    await token.connect(consumer).approve(await manager.getAddress(), ethers.MaxUint256);
    await expect(manager.connect(consumer).fundEngagement(id, 10e6, 3600))
      .to.emit(manager, "EngagementFunded");

    // escrow exists under the same id with mutual parties
    const p = await manager.getPayment(id);
    expect(p[1]).to.equal(1n); // HELD
    expect(p[2]).to.equal(consumer.address);
    expect(p[3]).to.equal(provider.address);

    await manager.connect(provider).markDelivered(id, ethers.id("deliverable"));
    await manager.connect(consumer).approveDelivery(id);

    const [, status] = await manager.getPayment(id);
    expect(status).to.equal(2n); // RELEASED
    expect(await manager.engagementsCompleted(provider.address)).to.equal(1n);
  });

  it("provider signing different terms reverts with TermsMismatch", async () => {
    const id = ethers.id("b2b-2");
    await propose(id, ethers.id("terms-A"));
    await expect(manager.connect(provider).acceptEngagement(id, ethers.id("terms-B")))
      .to.be.revertedWithCustomError(manager, "TermsMismatch");
  });

  it("only the named provider can accept; only the client can fund", async () => {
    const id = ethers.id("b2b-3");
    const terms = ethers.id("t3");
    await propose(id, terms);
    await expect(manager.connect(bystander).acceptEngagement(id, terms))
      .to.be.revertedWithCustomError(manager, "WrongProvider");
    await manager.connect(provider).acceptEngagement(id, terms);
    await token.connect(consumer).approve(await manager.getAddress(), ethers.MaxUint256);
    await expect(manager.connect(provider).fundEngagement(id, 10e6, 3600))
      .to.be.revertedWithCustomError(manager, "NotBuyer");
  });

  it("funding before mutual acceptance reverts (no one-sided start)", async () => {
    const id = ethers.id("b2b-4");
    await propose(id, ethers.id("t4"));
    await token.connect(consumer).approve(await manager.getAddress(), ethers.MaxUint256);
    await expect(manager.connect(consumer).fundEngagement(id, 10e6, 3600))
      .to.be.revertedWithCustomError(manager, "NotProposed");
  });

  it("no money moves at proposal time (commit without funding)", async () => {
    const before = await token.balanceOf(await manager.getAddress());
    await propose(ethers.id("b2b-5"), ethers.id("t5"));
    expect(await token.balanceOf(await manager.getAddress())).to.equal(before);
  });

  it("funded engagement ends in the escrow endings: partial pays provider + refunds buyer", async () => {
    const id = ethers.id("b2b-6");
    const terms = ethers.id("t6");
    await feed.setPrice(1e8);
    await acceptAndFund(id, terms);
    await manager.connect(provider).markDelivered(id, ethers.id("deliverable"));
    const amount = 5_000_000n; // $5.00 at 1.0
    await manager.connect(consumer).approveDeliveryPartial(id, amount * 60n / 100n);
    const [, status] = await manager.getPayment(id);
    expect(status).to.equal(3n); // CANCELLED (partially refunded)
    expect(await manager.engagementsCompleted(provider.address)).to.equal(1n); // partial still counts as completed
  });

  it("funded + undelivered + silence -> auto-refund, reputation NOT incremented", async () => {
    const id = ethers.id("b2b-7");
    await feed.setPrice(1e8);
    await acceptAndFund(id, ethers.id("t7"));
    await time.increase(3601);
    await manager.connect(bystander).autoResolve(id);
    expect(await manager.engagementsCompleted(provider.address)).to.equal(0n);
    const [, status] = await manager.getPayment(id);
    expect(status).to.equal(3n); // CANCELLED
  });

  it("duplicate engagement id reverts; cancel works before funding", async () => {
    const id = ethers.id("b2b-8");
    await propose(id, ethers.id("t8"));
    await expect(propose(id, ethers.id("t8"))).to.be.revertedWithCustomError(manager, "EngagementExists");
    await manager.connect(provider).cancelEngagement(id);
    const [status] = await manager.getEngagement(id);
    expect(status).to.equal(5n); // CANCELLED
  });

  // ---------------- Paxos USDG settlement ----------------

  describe("USDG settlement (Paxos Global Dollar)", function () {
    let usdg;

    beforeEach(async () => {
      const U = await ethers.getContractFactory("MockUSDG");
      usdg = await U.deploy();
      await usdg.transfer(consumer.address, 1000e6);
    });

    it("full USDG escrow cycle: quote -> approve -> settle -> deliver -> approveDelivery", async () => {
      await feed.setPrice(1e8);
      const id = ethers.id("usdg-1");
      const [amount] = await manager.quoteUSD(100); // $1.00 = 1 USDG

      await usdg.connect(consumer).approve(await manager.getAddress(), amount);
      await expect(
        manager.connect(consumer).settleInvoiceUSDEscrow(
          id, provider.address, ethers.id("usdg-ref"), await usdg.getAddress(), 100, amount, ethers.id("usdg-terms"), 3600
        )
      ).to.emit(manager, "USDSettled");

      const p = await manager.getPayment(id);
      expect(p[1]).to.equal(1n); // HELD
      expect(p[4]).to.equal(await usdg.getAddress()); // token is USDG

      await manager.connect(provider).markDelivered(id, ethers.id("usdg-evidence"));
      await manager.connect(consumer).approveDelivery(id);

      const [, status] = await manager.getPayment(id);
      expect(status).to.equal(2n); // RELEASED
      expect(await usdg.balanceOf(provider.address)).to.equal(amount); // paid in USDG
    });

    it("USDG autoResolve: delivered -> provider paid, undelivered -> buyer refunded", async () => {
      await feed.setPrice(1e8);
      const [amount] = await manager.quoteUSD(100);
      const usdgAddr = await usdg.getAddress();
      await usdg.connect(consumer).approve(await manager.getAddress(), amount * 2n);

      // A: delivered -> paid
      const idA = ethers.id("usdg-auto-1");
      await manager.connect(consumer).settleInvoiceUSDEscrow(
        idA, provider.address, ethers.id("rA"), usdgAddr, 100, amount, ethers.id("tA"), 3600
      );
      await manager.connect(provider).markDelivered(idA, ethers.id("eA"));

      // B: undelivered -> refunded
      const idB = ethers.id("usdg-auto-2");
      await manager.connect(consumer).settleInvoiceUSDEscrow(
        idB, provider.address, ethers.id("rB"), usdgAddr, 100, amount, ethers.id("tB"), 3600
      );

      const buyerBefore = await usdg.balanceOf(consumer.address);
      await time.increase(3601);
      await manager.connect(bystander).autoResolve(idA); // ANYONE can resolve
      await manager.connect(bystander).autoResolve(idB);

      expect(await usdg.balanceOf(provider.address)).to.equal(amount);          // A paid
      expect(await usdg.balanceOf(consumer.address)).to.equal(buyerBefore + amount); // B refunded
    });

    it("USDG works through the B2B engagement flow and counts reputation", async () => {
      await feed.setPrice(1e8);
      const usdgAddr = await usdg.getAddress();
      const id = ethers.id("usdg-b2b");
      const termsHash = ethers.id("usdg-b2b-terms");
      await manager.connect(consumer).proposeEngagement(id, provider.address, usdgAddr, 100, 0, termsHash);
      await manager.connect(provider).acceptEngagement(id, termsHash);
      const [amount] = await manager.quoteUSD(100);
      await usdg.connect(consumer).approve(await manager.getAddress(), amount);
      await manager.connect(consumer).fundEngagement(id, amount, 3600);
      await manager.connect(provider).markDelivered(id, ethers.id("usdg-b2b-e"));
      await manager.connect(consumer).approveDelivery(id);
      expect(await manager.engagementsCompleted(provider.address)).to.equal(1n);
      expect(await usdg.balanceOf(provider.address)).to.equal(await manager.quoteUSD(100).then(([a]) => a));
    });
  });
});
