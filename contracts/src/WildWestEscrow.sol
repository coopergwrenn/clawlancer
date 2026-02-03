// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title WildWestEscrow
/// @notice Escrow contract for Wild West Bots agent-to-agent transactions
/// @dev Supports both native ETH and ERC-20 tokens (USDC)
contract WildWestEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { FUNDED, RELEASED, REFUNDED }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint256 deadline;
        State state;
        address token; // address(0) = native ETH, otherwise ERC-20
    }

    mapping(bytes32 => Escrow) public escrows;
    uint256 public fee = 100; // 1% in basis points (100 = 1%)
    address public treasury;
    address public owner;

    // Base mainnet USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
    // Base Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e

    event Created(bytes32 indexed id, address indexed buyer, address indexed seller, uint256 amount, address token);
    event Released(bytes32 indexed id, uint256 sellerAmount, uint256 feeAmount);
    event Refunded(bytes32 indexed id);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event OwnershipTransferred(address oldOwner, address newOwner);

    error NotOwner();
    error EscrowExists();
    error EscrowNotFound();
    error NoValue();
    error NotBuyer();
    error NotAuthorized();
    error WrongState();
    error FeeTooHigh();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _treasury) {
        treasury = _treasury;
        owner = msg.sender;
    }

    /// @notice Create escrow with native ETH
    /// @param id Unique escrow identifier (bytes32)
    /// @param seller Address of the seller
    /// @param deadlineHours Hours until deadline for refund eligibility
    function create(bytes32 id, address seller, uint256 deadlineHours) external payable {
        if (escrows[id].buyer != address(0)) revert EscrowExists();
        if (msg.value == 0) revert NoValue();

        escrows[id] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: msg.value,
            deadline: block.timestamp + (deadlineHours * 1 hours),
            state: State.FUNDED,
            token: address(0)
        });

        emit Created(id, msg.sender, seller, msg.value, address(0));
    }

    /// @notice Create escrow with ERC-20 token (e.g., USDC)
    /// @param id Unique escrow identifier (bytes32)
    /// @param seller Address of the seller
    /// @param deadlineHours Hours until deadline for refund eligibility
    /// @param token Address of the ERC-20 token
    /// @param amount Amount of tokens to escrow
    function createWithToken(
        bytes32 id,
        address seller,
        uint256 deadlineHours,
        address token,
        uint256 amount
    ) external {
        if (escrows[id].buyer != address(0)) revert EscrowExists();
        if (amount == 0) revert NoValue();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        escrows[id] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            deadline: block.timestamp + (deadlineHours * 1 hours),
            state: State.FUNDED,
            token: token
        });

        emit Created(id, msg.sender, seller, amount, token);
    }

    /// @notice Release escrow funds to seller (called by buyer)
    /// @param id Escrow identifier
    function release(bytes32 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.buyer == address(0)) revert EscrowNotFound();
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != State.FUNDED) revert WrongState();

        e.state = State.RELEASED;

        uint256 feeAmount = (e.amount * fee) / 10000;
        uint256 sellerAmount = e.amount - feeAmount;

        if (e.token == address(0)) {
            // Native ETH - use call instead of transfer for safety
            (bool sellerSuccess, ) = payable(e.seller).call{value: sellerAmount}("");
            if (!sellerSuccess) revert TransferFailed();
            (bool treasurySuccess, ) = payable(treasury).call{value: feeAmount}("");
            if (!treasurySuccess) revert TransferFailed();
        } else {
            IERC20(e.token).safeTransfer(e.seller, sellerAmount);
            IERC20(e.token).safeTransfer(treasury, feeAmount);
        }

        emit Released(id, sellerAmount, feeAmount);
    }

    /// @notice Refund escrow to buyer (called by seller anytime, or buyer after deadline)
    /// @param id Escrow identifier
    function refund(bytes32 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.buyer == address(0)) revert EscrowNotFound();
        if (e.state != State.FUNDED) revert WrongState();

        // Seller can always refund (cancel), buyer can only refund after deadline
        bool isSeller = msg.sender == e.seller;
        bool isBuyerAfterDeadline = msg.sender == e.buyer && block.timestamp > e.deadline;

        if (!isSeller && !isBuyerAfterDeadline) revert NotAuthorized();

        e.state = State.REFUNDED;

        if (e.token == address(0)) {
            (bool success, ) = payable(e.buyer).call{value: e.amount}("");
            if (!success) revert TransferFailed();
        } else {
            IERC20(e.token).safeTransfer(e.buyer, e.amount);
        }

        emit Refunded(id);
    }

    /// @notice Get escrow details
    /// @param id Escrow identifier
    function getEscrow(bytes32 id) external view returns (
        address buyer,
        address seller,
        uint256 amount,
        uint256 deadline,
        State state,
        address token
    ) {
        Escrow storage e = escrows[id];
        return (e.buyer, e.seller, e.amount, e.deadline, e.state, e.token);
    }

    // Admin functions

    /// @notice Update fee percentage (owner only)
    /// @param newFee New fee in basis points (max 500 = 5%)
    function updateFee(uint256 newFee) external onlyOwner {
        if (newFee > 500) revert FeeTooHigh();
        uint256 oldFee = fee;
        fee = newFee;
        emit FeeUpdated(oldFee, newFee);
    }

    /// @notice Update treasury address (owner only)
    /// @param newTreasury New treasury address
    function updateTreasury(address newTreasury) external onlyOwner {
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Transfer ownership (owner only)
    /// @param newOwner New owner address
    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}
