// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/WildWestEscrow.sol";
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

contract EscrowTest is Test {
    WildWestEscrow public escrow;
    MockUSDC public usdc;

    address public treasury = address(0x1);
    address public buyer = address(0x2);
    address public seller = address(0x3);
    address public attacker = address(0x4);

    bytes32 public escrowId = keccak256("test-escrow-1");

    function setUp() public {
        escrow = new WildWestEscrow(treasury);
        usdc = new MockUSDC();

        // Fund test accounts
        vm.deal(buyer, 100 ether);
        vm.deal(seller, 10 ether);
        usdc.mint(buyer, 10_000 * 10**6); // 10,000 USDC
    }

    // ============ ETH Escrow Tests ============

    function test_CreateETHEscrow() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        (
            address _buyer,
            address _seller,
            uint256 amount,
            uint256 deadline,
            WildWestEscrow.State state,
            address token
        ) = escrow.getEscrow(escrowId);

        assertEq(_buyer, buyer);
        assertEq(_seller, seller);
        assertEq(amount, 1 ether);
        assertEq(deadline, block.timestamp + 24 hours);
        assertEq(uint256(state), uint256(WildWestEscrow.State.FUNDED));
        assertEq(token, address(0));
    }

    event Created(bytes32 indexed id, address indexed buyer, address indexed seller, uint256 amount, address token);

    function test_CreateETHEscrow_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit Created(escrowId, buyer, seller, 1 ether, address(0));

        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);
    }

    function test_CreateETHEscrow_RevertIfExists() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        vm.expectRevert(WildWestEscrow.EscrowExists.selector);
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);
    }

    function test_CreateETHEscrow_RevertIfNoValue() public {
        vm.expectRevert(WildWestEscrow.NoValue.selector);
        vm.prank(buyer);
        escrow.create{value: 0}(escrowId, seller, 24);
    }

    function test_ReleaseETHEscrow() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        uint256 sellerBalanceBefore = seller.balance;
        uint256 treasuryBalanceBefore = treasury.balance;

        vm.prank(buyer);
        escrow.release(escrowId);

        // 1% fee = 0.01 ETH, seller gets 0.99 ETH
        assertEq(seller.balance, sellerBalanceBefore + 0.99 ether);
        assertEq(treasury.balance, treasuryBalanceBefore + 0.01 ether);

        (, , , , WildWestEscrow.State state, ) = escrow.getEscrow(escrowId);
        assertEq(uint256(state), uint256(WildWestEscrow.State.RELEASED));
    }

    function test_ReleaseETHEscrow_RevertIfNotBuyer() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        vm.expectRevert(WildWestEscrow.NotBuyer.selector);
        vm.prank(seller);
        escrow.release(escrowId);
    }

    function test_ReleaseETHEscrow_RevertIfNotFound() public {
        vm.expectRevert(WildWestEscrow.EscrowNotFound.selector);
        vm.prank(buyer);
        escrow.release(escrowId);
    }

    function test_ReleaseETHEscrow_RevertIfWrongState() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        vm.prank(buyer);
        escrow.release(escrowId);

        vm.expectRevert(WildWestEscrow.WrongState.selector);
        vm.prank(buyer);
        escrow.release(escrowId);
    }

    function test_RefundETHEscrow_BySeller() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        uint256 buyerBalanceBefore = buyer.balance;

        vm.prank(seller);
        escrow.refund(escrowId);

        assertEq(buyer.balance, buyerBalanceBefore + 1 ether);

        (, , , , WildWestEscrow.State state, ) = escrow.getEscrow(escrowId);
        assertEq(uint256(state), uint256(WildWestEscrow.State.REFUNDED));
    }

    function test_RefundETHEscrow_ByBuyerAfterDeadline() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        // Warp past deadline
        vm.warp(block.timestamp + 25 hours);

        uint256 buyerBalanceBefore = buyer.balance;

        vm.prank(buyer);
        escrow.refund(escrowId);

        assertEq(buyer.balance, buyerBalanceBefore + 1 ether);
    }

    function test_RefundETHEscrow_RevertIfBuyerBeforeDeadline() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        vm.expectRevert(WildWestEscrow.NotAuthorized.selector);
        vm.prank(buyer);
        escrow.refund(escrowId);
    }

    function test_RefundETHEscrow_RevertIfAttacker() public {
        vm.prank(buyer);
        escrow.create{value: 1 ether}(escrowId, seller, 24);

        vm.expectRevert(WildWestEscrow.NotAuthorized.selector);
        vm.prank(attacker);
        escrow.refund(escrowId);
    }

    // ============ USDC Escrow Tests ============

    function test_CreateUSDCEscrow() public {
        uint256 amount = 100 * 10**6; // 100 USDC

        vm.startPrank(buyer);
        usdc.approve(address(escrow), amount);
        escrow.createWithToken(escrowId, seller, 24, address(usdc), amount);
        vm.stopPrank();

        (
            address _buyer,
            address _seller,
            uint256 _amount,
            ,
            WildWestEscrow.State state,
            address token
        ) = escrow.getEscrow(escrowId);

        assertEq(_buyer, buyer);
        assertEq(_seller, seller);
        assertEq(_amount, amount);
        assertEq(uint256(state), uint256(WildWestEscrow.State.FUNDED));
        assertEq(token, address(usdc));
    }

    function test_ReleaseUSDCEscrow() public {
        uint256 amount = 100 * 10**6; // 100 USDC

        vm.startPrank(buyer);
        usdc.approve(address(escrow), amount);
        escrow.createWithToken(escrowId, seller, 24, address(usdc), amount);
        vm.stopPrank();

        uint256 sellerBalanceBefore = usdc.balanceOf(seller);
        uint256 treasuryBalanceBefore = usdc.balanceOf(treasury);

        vm.prank(buyer);
        escrow.release(escrowId);

        // 1% fee = 1 USDC, seller gets 99 USDC
        assertEq(usdc.balanceOf(seller), sellerBalanceBefore + 99 * 10**6);
        assertEq(usdc.balanceOf(treasury), treasuryBalanceBefore + 1 * 10**6);
    }

    function test_RefundUSDCEscrow() public {
        uint256 amount = 100 * 10**6; // 100 USDC

        vm.startPrank(buyer);
        usdc.approve(address(escrow), amount);
        escrow.createWithToken(escrowId, seller, 24, address(usdc), amount);
        vm.stopPrank();

        uint256 buyerBalanceBefore = usdc.balanceOf(buyer);

        vm.prank(seller);
        escrow.refund(escrowId);

        assertEq(usdc.balanceOf(buyer), buyerBalanceBefore + amount);
    }

    // ============ Admin Tests ============

    function test_UpdateFee() public {
        escrow.updateFee(200); // 2%
        assertEq(escrow.fee(), 200);
    }

    function test_UpdateFee_RevertIfTooHigh() public {
        vm.expectRevert(WildWestEscrow.FeeTooHigh.selector);
        escrow.updateFee(501); // > 5%
    }

    function test_UpdateFee_RevertIfNotOwner() public {
        vm.expectRevert(WildWestEscrow.NotOwner.selector);
        vm.prank(attacker);
        escrow.updateFee(200);
    }

    function test_UpdateTreasury() public {
        address newTreasury = address(0x999);
        escrow.updateTreasury(newTreasury);
        assertEq(escrow.treasury(), newTreasury);
    }

    function test_TransferOwnership() public {
        address newOwner = address(0x888);
        escrow.transferOwnership(newOwner);
        assertEq(escrow.owner(), newOwner);

        // Old owner can no longer call admin functions
        vm.expectRevert(WildWestEscrow.NotOwner.selector);
        escrow.updateFee(200);

        // New owner can
        vm.prank(newOwner);
        escrow.updateFee(200);
    }

    // ============ Edge Cases ============

    function test_MultipleEscrows() public {
        bytes32 id1 = keccak256("escrow-1");
        bytes32 id2 = keccak256("escrow-2");

        vm.prank(buyer);
        escrow.create{value: 1 ether}(id1, seller, 24);

        vm.prank(buyer);
        escrow.create{value: 2 ether}(id2, seller, 48);

        (, , uint256 amount1, , , ) = escrow.getEscrow(id1);
        (, , uint256 amount2, , , ) = escrow.getEscrow(id2);

        assertEq(amount1, 1 ether);
        assertEq(amount2, 2 ether);
    }

    function test_SmallAmountEscrow() public {
        // 1 wei - fee would be 0, full amount goes to seller
        vm.prank(buyer);
        escrow.create{value: 1}(escrowId, seller, 24);

        uint256 sellerBalanceBefore = seller.balance;

        vm.prank(buyer);
        escrow.release(escrowId);

        // With 1 wei, fee is 0 (integer division), seller gets 1 wei
        assertEq(seller.balance, sellerBalanceBefore + 1);
    }

    // ============ Fuzz Tests ============

    function testFuzz_CreateAndRelease(uint96 amount) public {
        vm.assume(amount > 0);

        vm.deal(buyer, uint256(amount) + 1 ether);

        vm.prank(buyer);
        escrow.create{value: amount}(escrowId, seller, 24);

        uint256 sellerBalanceBefore = seller.balance;
        uint256 treasuryBalanceBefore = treasury.balance;

        vm.prank(buyer);
        escrow.release(escrowId);

        uint256 expectedFee = (uint256(amount) * 100) / 10000;
        uint256 expectedSellerAmount = uint256(amount) - expectedFee;

        assertEq(seller.balance, sellerBalanceBefore + expectedSellerAmount);
        assertEq(treasury.balance, treasuryBalanceBefore + expectedFee);
    }
}
