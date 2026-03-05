// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/InstaClawAmbassadorV2.sol";

contract DeployAmbassadorV2 is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        InstaClawAmbassadorV2 ambassador = new InstaClawAmbassadorV2(deployer);

        // Set base image URI so each token gets .../badge/001, .../badge/002, etc.
        ambassador.setBaseImageURI("https://instaclaw.io/api/ambassador/badge/");

        console.log("=== InstaClawAmbassadorV2 Base Mainnet Deployment ===");
        console.log("Contract deployed to:", address(ambassador));
        console.log("Owner (minter):", deployer);
        console.log("Base image URI set to: https://instaclaw.io/api/ambassador/badge/");
        console.log("");
        console.log("Update CONTRACT in instaclaw/lib/ambassador-nft.ts to:");
        console.log(address(ambassador));

        vm.stopBroadcast();
    }
}
