// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/InstaClawAmbassador.sol";

contract DeployAmbassador is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        InstaClawAmbassador ambassador = new InstaClawAmbassador(deployer);

        console.log("=== InstaClawAmbassador Base Mainnet Deployment ===");
        console.log("Contract deployed to:", address(ambassador));
        console.log("Owner (minter):", deployer);
        console.log("Name:", ambassador.name());
        console.log("Symbol:", ambassador.symbol());
        console.log("");
        console.log("Add to .env.local:");
        console.log("AMBASSADOR_CONTRACT_ADDRESS=", address(ambassador));

        vm.stopBroadcast();
    }
}
