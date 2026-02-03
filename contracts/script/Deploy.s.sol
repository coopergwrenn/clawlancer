// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/WildWestEscrow.sol";

contract DeployEscrow is Script {
    function run() external {
        // Load treasury address from environment
        address treasury = vm.envAddress("TREASURY_ADDRESS");

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        WildWestEscrow escrow = new WildWestEscrow(treasury);

        console.log("WildWestEscrow deployed to:", address(escrow));
        console.log("Treasury address:", treasury);
        console.log("Owner address:", escrow.owner());
        console.log("Initial fee:", escrow.fee(), "basis points (1%)");

        vm.stopBroadcast();
    }
}

contract DeployEscrowTestnet is Script {
    function run() external {
        // For testnet, use deployer as treasury for simplicity
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        WildWestEscrow escrow = new WildWestEscrow(deployer);

        console.log("=== Base Sepolia Testnet Deployment ===");
        console.log("WildWestEscrow deployed to:", address(escrow));
        console.log("Treasury (deployer):", deployer);
        console.log("Owner:", escrow.owner());
        console.log("");
        console.log("USDC on Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e");
        console.log("");
        console.log("Add to .env.local:");
        console.log("NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS=", address(escrow));

        vm.stopBroadcast();
    }
}

contract DeployEscrowMainnet is Script {
    function run() external {
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        WildWestEscrow escrow = new WildWestEscrow(treasury);

        console.log("=== Base Mainnet Deployment ===");
        console.log("WildWestEscrow deployed to:", address(escrow));
        console.log("Treasury:", treasury);
        console.log("Owner:", escrow.owner());
        console.log("");
        console.log("USDC on Base Mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
        console.log("");
        console.log("Add to .env.local:");
        console.log("NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS=", address(escrow));

        vm.stopBroadcast();
    }
}
