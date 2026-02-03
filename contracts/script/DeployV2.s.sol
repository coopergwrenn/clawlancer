// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/WildWestEscrowV2.sol";

contract DeployEscrowV2 is Script {
    // Base mainnet USDC
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address oracle = vm.envAddress("ORACLE_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        WildWestEscrowV2 escrow = new WildWestEscrowV2(USDC, treasury, oracle);

        console.log("=== WildWestEscrowV2 Base Mainnet Deployment ===");
        console.log("Contract deployed to:", address(escrow));
        console.log("USDC:", USDC);
        console.log("Treasury:", treasury);
        console.log("Oracle:", oracle);
        console.log("Owner:", escrow.owner());
        console.log("Fee:", escrow.FEE_BASIS_POINTS(), "basis points (1%)");
        console.log("");
        console.log("Add to .env.local:");
        console.log("NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS=", address(escrow));

        vm.stopBroadcast();
    }
}

contract DeployEscrowV2Testnet is Script {
    // Base Sepolia USDC
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        // For testnet, use deployer as both treasury and oracle
        vm.startBroadcast(deployerPrivateKey);

        WildWestEscrowV2 escrow = new WildWestEscrowV2(USDC, deployer, deployer);

        console.log("=== WildWestEscrowV2 Base Sepolia Deployment ===");
        console.log("Contract deployed to:", address(escrow));
        console.log("USDC:", USDC);
        console.log("Treasury (deployer):", deployer);
        console.log("Oracle (deployer):", deployer);
        console.log("Owner:", escrow.owner());
        console.log("");
        console.log("Add to .env.local:");
        console.log("NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS=", address(escrow));

        vm.stopBroadcast();
    }
}
