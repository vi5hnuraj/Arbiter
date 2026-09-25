import { ethers } from 'ethers';
import solc from 'solc';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config();

const contractPath = path.resolve('contracts/ArbiterPaymentManager.sol');
const contractSource = fs.readFileSync(contractPath, 'utf-8');

async function deploy() {
    console.log("Compiling ArbiterPaymentManager...");

    const input = {
        language: 'Solidity',
        sources: {
            'ArbiterPaymentManager.sol': { content: contractSource }
        },
        settings: {
            outputSelection: { '*': { '*': ['*'] } }
        }
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));

    if (output.errors) {
        let hasError = false;
        output.errors.forEach(err => {
            if (err.severity === 'error') hasError = true;
            console.error(err.formattedMessage);
        });
        if (hasError) return;
    }

    const contract = output.contracts['ArbiterPaymentManager.sol']['ArbiterPaymentManager'];
    const abi = contract.abi;
    const bytecode = contract.evm.bytecode.object;

    console.log("Compiled successfully!");

    const rpcUrl = process.env.RPC_URL || process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io";
    const privateKey = process.env.TREASURY_PRIVATE_KEY;

    if (!rpcUrl || !privateKey) {
        console.error("Missing RPC URL or Private Key in .env");
        return;
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log("Deploying with Treasury Wallet:", wallet.address);

    const factory = new ethers.ContractFactory(abi, bytecode, wallet);

    try {
        const deployedContract = await factory.deploy();
        await deployedContract.waitForDeployment();
        const address = await deployedContract.getAddress();

        console.log("\n============================================");
        console.log("GLOBAL PAY PAYMENT MANAGER DEPLOYED!");
        console.log("Contract Address:", address);
        console.log("============================================\n");

        const contractData = { address, abi };
        // The Arc scheduled-payment worker reads globalPayData.json against the
        // Arc RPC — only clobber it when actually deploying to Arc. Arbitrum Sepolia
        // (KeeperHub rail) deployments go to a separate file.
        const isArbSepolia = String(rpcUrl).includes('sepolia-rollup.arbitrum.io');
        const outFile = isArbSepolia ? './globalPayData.arbitrum.json' : './globalPayData.json';
        fs.writeFileSync(outFile, JSON.stringify(contractData, null, 2));
        console.log(`Saved to ${outFile}`);

        console.log("\nAdd to .env:");
        console.log(`ARBITER_MANAGER_ADDRESS=${address}`);
    } catch (err) {
        console.error("Deployment failed:", err);
    }
}

deploy();
