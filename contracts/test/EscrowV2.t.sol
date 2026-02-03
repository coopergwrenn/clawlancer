// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/WildWestEscrowV2.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Mock USDC for testing
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {
        _mint(msg.sender, 1_000_000 * 10**6); // 1M USDC (6 decimals)
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract EscrowV2Test is Test {
    WildWestEscrowV2 public escrow;
    MockUSDC public usdc;

    address public treasury = address(0x1);
    address public oracle = address(0x2);
    address public buyer = address(0x3);
    address public seller = address(0x4);
    address public attacker = address(0x5);

    bytes32 public escrowId = keccak256("test-escrow-1");
    bytes32 public deliverableHash = keccak256("test-deliverable-content");

    uint256 constant AMOUNT = 100 * 10**6; // 100 USDC
    uint256 constant DEADLINE_HOURS = 24;
    uint256 constant DISPUTE_WINDOW_HOURS = 24;

    // Events
    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 deadline,
        uint256 disputeWindowHours
    );
    event EscrowDelivered(bytes32 indexed escrowId, uint256 deliveredAt, bytes32 deliverableHash);
    event EscrowDisputed(bytes32 indexed escrowId, address disputedBy);
    event EscrowReleased(bytes32 indexed escrowId, uint256 sellerAmount, uint256 feeAmount);
    event EscrowRefunded(bytes32 indexed escrowId, uint256 amount);
    event OracleChangeInitiated(address indexed currentOracle, address indexed pendingOracle, uint256 effectiveTime);
    event OracleChangeCompleted(address indexed oldOracle, address indexed newOracle);
    event ContractPaused(address indexed by);
    event ContractUnpaused(address indexed by);

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new WildWestEscrowV2(address(usdc), treasury, oracle);

        // Fund test accounts with USDC
        usdc.mint(buyer, 10_000 * 10**6); // 10,000 USDC
        usdc.mint(seller, 1_000 * 10**6); // 1,000 USDC
    }

    // ============ Helper Functions ============

    function _createEscrow() internal {
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        escrow.createEscrow(escrowId, seller, AMOUNT, DEADLINE_HOURS, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();
    }

    function _createAndDeliver() internal {
        _createEscrow();
        vm.prank(seller);
        escrow.markDelivered(escrowId, deliverableHash);
    }

    // ============ Create Escrow Tests ============

    function test_CreateEscrow() public {
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        escrow.createEscrow(escrowId, seller, AMOUNT, DEADLINE_HOURS, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);

        assertEq(e.buyer, buyer);
        assertEq(e.seller, seller);
        assertEq(e.amount, AMOUNT);
        assertEq(e.deadline, block.timestamp + DEADLINE_HOURS * 1 hours);
        assertEq(e.disputeWindowHours, DISPUTE_WINDOW_HOURS);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.FUNDED));
        assertFalse(e.disputed);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_CreateEscrow_EmitsEvent() public {
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit EscrowCreated(escrowId, buyer, seller, AMOUNT, block.timestamp + DEADLINE_HOURS * 1 hours, DISPUTE_WINDOW_HOURS);

        escrow.createEscrow(escrowId, seller, AMOUNT, DEADLINE_HOURS, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();
    }

    function test_CreateEscrow_RevertIfExists() public {
        _createEscrow();

        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert("Escrow exists");
        escrow.createEscrow(escrowId, seller, AMOUNT, DEADLINE_HOURS, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();
    }

    function test_CreateEscrow_RevertIfSelfEscrow() public {
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert("Cannot escrow to self");
        escrow.createEscrow(escrowId, buyer, AMOUNT, DEADLINE_HOURS, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();
    }

    function test_CreateEscrow_RevertIfInvalidDeadline() public {
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert("Deadline 1-720 hours");
        escrow.createEscrow(escrowId, seller, AMOUNT, 721, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();
    }

    function test_CreateEscrow_RevertIfInvalidDisputeWindow() public {
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert("Dispute window 1-168 hours");
        escrow.createEscrow(escrowId, seller, AMOUNT, DEADLINE_HOURS, 169);
        vm.stopPrank();
    }

    // ============ Delivery Tests ============

    function test_MarkDelivered_BySeller() public {
        _createEscrow();

        vm.prank(seller);
        escrow.markDelivered(escrowId, deliverableHash);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.DELIVERED));
        assertEq(e.deliverableHash, deliverableHash);
        assertGt(e.deliveredAt, 0);
    }

    function test_MarkDelivered_ByOracle() public {
        _createEscrow();

        vm.prank(oracle);
        escrow.markDelivered(escrowId, deliverableHash);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.DELIVERED));
    }

    function test_MarkDelivered_EmitsEvent() public {
        _createEscrow();

        vm.expectEmit(true, false, false, true);
        emit EscrowDelivered(escrowId, block.timestamp, deliverableHash);

        vm.prank(seller);
        escrow.markDelivered(escrowId, deliverableHash);
    }

    function test_MarkDelivered_RevertIfNotSellerOrOracle() public {
        _createEscrow();

        vm.expectRevert("Only seller or oracle");
        vm.prank(buyer);
        escrow.markDelivered(escrowId, deliverableHash);
    }

    function test_MarkDelivered_RevertIfPastDeadline() public {
        _createEscrow();
        vm.warp(block.timestamp + DEADLINE_HOURS * 1 hours + 1);

        vm.expectRevert("Deadline passed");
        vm.prank(seller);
        escrow.markDelivered(escrowId, deliverableHash);
    }

    // ============ Dispute Tests ============

    function test_Dispute() public {
        _createAndDeliver();

        vm.prank(buyer);
        escrow.dispute(escrowId);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.DISPUTED));
        assertTrue(e.disputed);
    }

    function test_Dispute_EmitsEvent() public {
        _createAndDeliver();

        vm.expectEmit(true, false, false, true);
        emit EscrowDisputed(escrowId, buyer);

        vm.prank(buyer);
        escrow.dispute(escrowId);
    }

    function test_Dispute_RevertIfNotDelivered() public {
        _createEscrow();

        vm.expectRevert("Not delivered");
        vm.prank(buyer);
        escrow.dispute(escrowId);
    }

    function test_Dispute_RevertIfNotBuyer() public {
        _createAndDeliver();

        vm.expectRevert("Only buyer");
        vm.prank(seller);
        escrow.dispute(escrowId);
    }

    function test_Dispute_RevertIfAlreadyDisputed() public {
        _createAndDeliver();
        vm.prank(buyer);
        escrow.dispute(escrowId);

        // State is now DISPUTED, so it fails the "state == DELIVERED" check first
        vm.expectRevert("Not delivered");
        vm.prank(buyer);
        escrow.dispute(escrowId);
    }

    function test_Dispute_RevertIfWindowClosed() public {
        _createAndDeliver();
        vm.warp(block.timestamp + DISPUTE_WINDOW_HOURS * 1 hours + 1);

        vm.expectRevert("Dispute window closed");
        vm.prank(buyer);
        escrow.dispute(escrowId);
    }

    // ============ Release Tests ============

    function test_Release_ByBuyer_BeforeDelivery() public {
        _createEscrow();

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(buyer);
        escrow.release(escrowId);

        // 1% fee
        uint256 fee = AMOUNT / 100;
        uint256 sellerAmount = AMOUNT - fee;

        assertEq(usdc.balanceOf(seller), sellerBefore + sellerAmount);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + fee);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.RELEASED));
    }

    function test_Release_ByBuyer_AfterDelivery() public {
        _createAndDeliver();

        vm.prank(buyer);
        escrow.release(escrowId);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.RELEASED));
    }

    function test_Release_ByOracle_AfterDisputeWindow() public {
        _createAndDeliver();
        vm.warp(block.timestamp + DISPUTE_WINDOW_HOURS * 1 hours + 1);

        vm.prank(oracle);
        escrow.release(escrowId);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.RELEASED));
    }

    function test_Release_ByOracle_RevertIfDisputeWindowActive() public {
        _createAndDeliver();

        vm.expectRevert("Dispute window active");
        vm.prank(oracle);
        escrow.release(escrowId);
    }

    function test_Release_RevertIfDisputed() public {
        _createAndDeliver();
        vm.prank(buyer);
        escrow.dispute(escrowId);

        // State is now DISPUTED, so it fails the state check first (not FUNDED or DELIVERED)
        vm.expectRevert("Cannot release");
        vm.prank(buyer);
        escrow.release(escrowId);
    }

    function test_Release_EmitsEvent() public {
        _createEscrow();

        uint256 fee = AMOUNT / 100;
        uint256 sellerAmount = AMOUNT - fee;

        vm.expectEmit(true, false, false, true);
        emit EscrowReleased(escrowId, sellerAmount, fee);

        vm.prank(buyer);
        escrow.release(escrowId);
    }

    // ============ Refund Tests ============

    function test_Refund_ByBuyer_AfterDeadline() public {
        _createEscrow();
        vm.warp(block.timestamp + DEADLINE_HOURS * 1 hours + 1);

        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        escrow.refund(escrowId);

        assertEq(usdc.balanceOf(buyer), buyerBefore + AMOUNT);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.REFUNDED));
    }

    function test_Refund_ByOracle() public {
        _createEscrow();

        vm.prank(oracle);
        escrow.refund(escrowId);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.REFUNDED));
    }

    function test_Refund_RevertIfBuyerBeforeDeadline() public {
        _createEscrow();

        vm.expectRevert("Deadline not passed");
        vm.prank(buyer);
        escrow.refund(escrowId);
    }

    function test_Refund_RevertIfDeliveredAndNotDisputed() public {
        _createAndDeliver();

        vm.expectRevert("Must dispute first");
        vm.prank(buyer);
        escrow.refund(escrowId);
    }

    function test_Refund_RevertIfDisputedByBuyer() public {
        _createAndDeliver();
        vm.prank(buyer);
        escrow.dispute(escrowId);

        vm.expectRevert("Awaiting dispute resolution");
        vm.prank(buyer);
        escrow.refund(escrowId);
    }

    function test_Refund_EmitsEvent() public {
        _createEscrow();

        vm.expectEmit(true, false, false, true);
        emit EscrowRefunded(escrowId, AMOUNT);

        vm.prank(oracle);
        escrow.refund(escrowId);
    }

    // ============ Dispute Resolution Tests ============

    function test_ResolveDispute_ReleaseToSeller() public {
        _createAndDeliver();
        vm.prank(buyer);
        escrow.dispute(escrowId);

        uint256 sellerBefore = usdc.balanceOf(seller);

        vm.prank(oracle);
        escrow.resolveDispute(escrowId, true);

        uint256 fee = AMOUNT / 100;
        uint256 sellerAmount = AMOUNT - fee;
        assertEq(usdc.balanceOf(seller), sellerBefore + sellerAmount);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.RELEASED));
    }

    function test_ResolveDispute_RefundToBuyer() public {
        _createAndDeliver();
        vm.prank(buyer);
        escrow.dispute(escrowId);

        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(oracle);
        escrow.resolveDispute(escrowId, false);

        assertEq(usdc.balanceOf(buyer), buyerBefore + AMOUNT);

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.REFUNDED));
    }

    function test_ResolveDispute_RevertIfNotOracle() public {
        _createAndDeliver();
        vm.prank(buyer);
        escrow.dispute(escrowId);

        vm.expectRevert("Only oracle");
        vm.prank(buyer);
        escrow.resolveDispute(escrowId, true);
    }

    function test_ResolveDispute_RevertIfNotDisputed() public {
        _createAndDeliver();

        vm.expectRevert("Not disputed");
        vm.prank(oracle);
        escrow.resolveDispute(escrowId, true);
    }

    // ============ View Functions ============

    function test_IsAutoReleaseReady_True() public {
        _createAndDeliver();
        vm.warp(block.timestamp + DISPUTE_WINDOW_HOURS * 1 hours + 1);

        assertTrue(escrow.isAutoReleaseReady(escrowId));
    }

    function test_IsAutoReleaseReady_False_BeforeWindow() public {
        _createAndDeliver();

        assertFalse(escrow.isAutoReleaseReady(escrowId));
    }

    function test_IsAutoReleaseReady_False_IfDisputed() public {
        _createAndDeliver();
        vm.prank(buyer);
        escrow.dispute(escrowId);
        vm.warp(block.timestamp + DISPUTE_WINDOW_HOURS * 1 hours + 1);

        assertFalse(escrow.isAutoReleaseReady(escrowId));
    }

    function test_IsRefundReady_True() public {
        _createEscrow();
        vm.warp(block.timestamp + DEADLINE_HOURS * 1 hours + 1);

        assertTrue(escrow.isRefundReady(escrowId));
    }

    function test_IsRefundReady_False_BeforeDeadline() public {
        _createEscrow();

        assertFalse(escrow.isRefundReady(escrowId));
    }

    function test_IsRefundReady_False_IfDelivered() public {
        _createAndDeliver();
        vm.warp(block.timestamp + DEADLINE_HOURS * 1 hours + 1);

        assertFalse(escrow.isRefundReady(escrowId));
    }

    // ============ Oracle Change Tests ============

    function test_OracleChange_InitiateAndComplete() public {
        address newOracle = address(0x999);

        escrow.initiateOracleChange(newOracle);
        assertEq(escrow.pendingOracle(), newOracle);
        assertEq(escrow.oracleChangeTimestamp(), block.timestamp + 24 hours);

        vm.warp(block.timestamp + 24 hours);
        escrow.completeOracleChange();

        assertEq(escrow.oracle(), newOracle);
        assertEq(escrow.pendingOracle(), address(0));
    }

    function test_OracleChange_RevertIfTooSoon() public {
        address newOracle = address(0x999);

        escrow.initiateOracleChange(newOracle);

        vm.expectRevert("Delay not passed");
        escrow.completeOracleChange();
    }

    function test_OracleChange_Cancel() public {
        address newOracle = address(0x999);

        escrow.initiateOracleChange(newOracle);
        escrow.cancelOracleChange();

        assertEq(escrow.pendingOracle(), address(0));
        assertEq(escrow.oracle(), oracle);
    }

    function test_OracleChange_RevertIfNotOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        escrow.initiateOracleChange(address(0x999));
    }

    // ============ Pause Tests ============

    function test_Pause() public {
        escrow.pause();
        assertTrue(escrow.paused());
    }

    function test_Pause_BlocksCreation() public {
        escrow.pause();

        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert();
        escrow.createEscrow(escrowId, seller, AMOUNT, DEADLINE_HOURS, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();
    }

    function test_Pause_BlocksRelease() public {
        _createEscrow();
        escrow.pause();

        vm.expectRevert();
        vm.prank(buyer);
        escrow.release(escrowId);
    }

    function test_Unpause() public {
        escrow.pause();
        escrow.unpause();
        assertFalse(escrow.paused());

        // Should work again
        _createEscrow();
        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(WildWestEscrowV2.EscrowState.FUNDED));
    }

    function test_Pause_RevertIfNotOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        escrow.pause();
    }

    // ============ Treasury Update ============

    function test_SetTreasury() public {
        address newTreasury = address(0x888);
        escrow.setTreasury(newTreasury);
        assertEq(escrow.treasury(), newTreasury);
    }

    function test_SetTreasury_RevertIfZero() public {
        vm.expectRevert("Invalid treasury address");
        escrow.setTreasury(address(0));
    }

    // ============ Fee Calculation Tests ============

    function test_FeeCalculation_Standard() public {
        _createEscrow();

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(buyer);
        escrow.release(escrowId);

        // 100 USDC * 1% = 1 USDC fee
        assertEq(usdc.balanceOf(seller), sellerBefore + 99 * 10**6);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + 1 * 10**6);
    }

    function test_FeeCalculation_SmallAmount() public {
        uint256 smallAmount = 50; // 0.00005 USDC - fee would be 0

        vm.startPrank(buyer);
        usdc.approve(address(escrow), smallAmount);
        escrow.createEscrow(escrowId, seller, smallAmount, DEADLINE_HOURS, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();

        uint256 sellerBefore = usdc.balanceOf(seller);

        vm.prank(buyer);
        escrow.release(escrowId);

        // Fee should be 0, seller gets full amount
        assertEq(usdc.balanceOf(seller), sellerBefore + smallAmount);
    }

    // ============ Fuzz Tests ============

    function testFuzz_CreateAndRelease(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 1_000_000 * 10**6);

        usdc.mint(buyer, amount);

        vm.startPrank(buyer);
        usdc.approve(address(escrow), amount);
        escrow.createEscrow(escrowId, seller, amount, DEADLINE_HOURS, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(buyer);
        escrow.release(escrowId);

        uint256 expectedFee = (uint256(amount) * 100) / 10000;
        uint256 expectedSellerAmount = uint256(amount) - expectedFee;

        assertEq(usdc.balanceOf(seller), sellerBefore + expectedSellerAmount);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + expectedFee);
    }

    function testFuzz_DeadlineEnforcement(uint16 deadlineHours) public {
        vm.assume(deadlineHours > 0 && deadlineHours <= 720);

        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        escrow.createEscrow(escrowId, seller, AMOUNT, deadlineHours, DISPUTE_WINDOW_HOURS);
        vm.stopPrank();

        WildWestEscrowV2.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.deadline, block.timestamp + uint256(deadlineHours) * 1 hours);
    }
}

// ============ Reentrancy Attack Test ============

contract ReentrancyAttacker {
    WildWestEscrowV2 public target;
    bytes32 public escrowId;
    bool public attacked;

    function setTarget(address _target, bytes32 _escrowId) external {
        target = WildWestEscrowV2(_target);
        escrowId = _escrowId;
    }

    function attack() external {
        target.release(escrowId);
    }

    // This would be called when receiving tokens if using a hook
    // USDC doesn't have hooks, but this tests the ReentrancyGuard pattern
    fallback() external {
        if (!attacked) {
            attacked = true;
            // Attempt reentrant call - should fail due to ReentrancyGuard
            try target.release(escrowId) {} catch {}
        }
    }
}
