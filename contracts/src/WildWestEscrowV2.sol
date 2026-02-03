// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title WildWestEscrowV2
/// @notice Escrow contract with oracle-controlled release for agent marketplace
/// @dev V2 adds: oracle permissions, delivery tracking, dispute flow, pausable
contract WildWestEscrowV2 is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    // Constants
    uint256 public constant FEE_BASIS_POINTS = 100; // 1%
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant ORACLE_CHANGE_DELAY = 24 hours;

    // State
    IERC20 public immutable usdc;
    address public treasury;
    address public oracle;
    address public pendingOracle;
    uint256 public oracleChangeTimestamp;

    enum EscrowState { NONE, FUNDED, DELIVERED, DISPUTED, RELEASED, REFUNDED }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint256 createdAt;
        uint256 deadline;
        uint256 deliveredAt;
        uint256 disputeWindowHours;
        bytes32 deliverableHash; // Hash of delivered content for on-chain proof
        EscrowState state;
        bool disputed;
    }

    mapping(bytes32 => Escrow) public escrows;

    // Events - These are the source of truth for reputation
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
    event OracleChangeCancelled(address indexed cancelledOracle);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event ContractPaused(address indexed by);
    event ContractUnpaused(address indexed by);

    // Modifiers
    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle");
        _;
    }

    modifier onlyBuyerOrOracle(bytes32 escrowId) {
        require(msg.sender == escrows[escrowId].buyer || msg.sender == oracle, "Only buyer or oracle");
        _;
    }

    modifier onlySellerOrOracle(bytes32 escrowId) {
        require(msg.sender == escrows[escrowId].seller || msg.sender == oracle, "Only seller or oracle");
        _;
    }

    constructor(address _usdc, address _treasury, address _oracle) Ownable(msg.sender) {
        require(_usdc != address(0), "Invalid USDC address");
        require(_treasury != address(0), "Invalid treasury address");
        require(_oracle != address(0), "Invalid oracle address");
        usdc = IERC20(_usdc);
        treasury = _treasury;
        oracle = _oracle;
    }

    // ============ ESCROW FUNCTIONS ============

    /// @notice Create escrow - buyer locks funds
    /// @dev Emits EscrowCreated for reputation tracking
    function createEscrow(
        bytes32 escrowId,
        address seller,
        uint256 amount,
        uint256 deadlineHours,
        uint256 disputeWindowHours
    ) external nonReentrant whenNotPaused {
        require(escrows[escrowId].state == EscrowState.NONE, "Escrow exists");
        require(seller != address(0), "Invalid seller");
        require(seller != msg.sender, "Cannot escrow to self");
        require(amount > 0, "Amount must be > 0");
        require(deadlineHours > 0 && deadlineHours <= 720, "Deadline 1-720 hours");
        require(disputeWindowHours > 0 && disputeWindowHours <= 168, "Dispute window 1-168 hours");

        escrows[escrowId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            createdAt: block.timestamp,
            deadline: block.timestamp + (deadlineHours * 1 hours),
            deliveredAt: 0,
            disputeWindowHours: disputeWindowHours,
            deliverableHash: bytes32(0),
            state: EscrowState.FUNDED,
            disputed: false
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit EscrowCreated(escrowId, msg.sender, seller, amount, escrows[escrowId].deadline, disputeWindowHours);
    }

    /// @notice Mark as delivered - seller or oracle can call
    /// @dev Emits EscrowDelivered. Deliverable content stored locally.
    function markDelivered(bytes32 escrowId, bytes32 deliverableHash) external whenNotPaused onlySellerOrOracle(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.FUNDED, "Not funded");
        require(block.timestamp <= escrow.deadline, "Deadline passed");

        escrow.deliveredAt = block.timestamp;
        escrow.deliverableHash = deliverableHash;
        escrow.state = EscrowState.DELIVERED;

        emit EscrowDelivered(escrowId, block.timestamp, deliverableHash);
    }

    /// @notice Dispute - buyer can call within dispute window
    /// @dev Emits EscrowDisputed. Dispute reason stored locally.
    function dispute(bytes32 escrowId) external whenNotPaused {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.DELIVERED, "Not delivered");
        require(msg.sender == escrow.buyer, "Only buyer");
        require(!escrow.disputed, "Already disputed");
        require(block.timestamp <= escrow.deliveredAt + (escrow.disputeWindowHours * 1 hours), "Dispute window closed");

        escrow.disputed = true;
        escrow.state = EscrowState.DISPUTED;

        emit EscrowDisputed(escrowId, msg.sender);
    }

    /// @notice Release - buyer, oracle, or auto after dispute window
    /// @dev Emits EscrowReleased - this is the PRIMARY reputation signal
    function release(bytes32 escrowId) external nonReentrant whenNotPaused onlyBuyerOrOracle(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.FUNDED || escrow.state == EscrowState.DELIVERED, "Cannot release");
        require(!escrow.disputed, "Disputed");

        // If delivered, oracle can only release after dispute window
        if (escrow.state == EscrowState.DELIVERED && msg.sender == oracle) {
            require(block.timestamp > escrow.deliveredAt + (escrow.disputeWindowHours * 1 hours), "Dispute window active");
        }

        escrow.state = EscrowState.RELEASED;

        uint256 fee = (escrow.amount * FEE_BASIS_POINTS) / BASIS_POINTS;
        uint256 sellerAmount = escrow.amount - fee;

        usdc.safeTransfer(escrow.seller, sellerAmount);
        if (fee > 0) {
            usdc.safeTransfer(treasury, fee);
        }

        emit EscrowReleased(escrowId, sellerAmount, fee);
    }

    /// @notice Refund - buyer after deadline, or oracle anytime
    /// @dev Emits EscrowRefunded - negative reputation signal for seller
    function refund(bytes32 escrowId) external nonReentrant whenNotPaused onlyBuyerOrOracle(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(
            escrow.state == EscrowState.FUNDED ||
            escrow.state == EscrowState.DELIVERED ||
            escrow.state == EscrowState.DISPUTED,
            "Cannot refund"
        );

        // Buyer can only refund after deadline (if not delivered) or if disputed
        if (msg.sender == escrow.buyer) {
            if (escrow.state == EscrowState.FUNDED) {
                require(block.timestamp > escrow.deadline, "Deadline not passed");
            } else if (escrow.state == EscrowState.DELIVERED) {
                revert("Must dispute first");
            }
            if (escrow.state == EscrowState.DISPUTED) {
                revert("Awaiting dispute resolution");
            }
        }

        escrow.state = EscrowState.REFUNDED;

        usdc.safeTransfer(escrow.buyer, escrow.amount);

        emit EscrowRefunded(escrowId, escrow.amount);
    }

    /// @notice Resolve dispute - only oracle
    /// @dev Emits EscrowReleased or EscrowRefunded based on decision
    function resolveDispute(bytes32 escrowId, bool releaseToSeller) external nonReentrant whenNotPaused onlyOracle {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.DISPUTED, "Not disputed");

        if (releaseToSeller) {
            escrow.state = EscrowState.RELEASED;

            uint256 fee = (escrow.amount * FEE_BASIS_POINTS) / BASIS_POINTS;
            uint256 sellerAmount = escrow.amount - fee;

            usdc.safeTransfer(escrow.seller, sellerAmount);
            if (fee > 0) {
                usdc.safeTransfer(treasury, fee);
            }

            emit EscrowReleased(escrowId, sellerAmount, fee);
        } else {
            escrow.state = EscrowState.REFUNDED;

            usdc.safeTransfer(escrow.buyer, escrow.amount);

            emit EscrowRefunded(escrowId, escrow.amount);
        }
    }

    // ============ VIEW FUNCTIONS ============

    /// @notice Check if auto-release is ready (used by oracle cron)
    function isAutoReleaseReady(bytes32 escrowId) external view returns (bool) {
        Escrow storage escrow = escrows[escrowId];
        if (escrow.state != EscrowState.DELIVERED) return false;
        if (escrow.disputed) return false;
        return block.timestamp > escrow.deliveredAt + (escrow.disputeWindowHours * 1 hours);
    }

    /// @notice Check if refund is ready (deadline passed, not delivered)
    function isRefundReady(bytes32 escrowId) external view returns (bool) {
        Escrow storage escrow = escrows[escrowId];
        if (escrow.state != EscrowState.FUNDED) return false;
        return block.timestamp > escrow.deadline;
    }

    /// @notice Get full escrow details
    function getEscrow(bytes32 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }

    // ============ ADMIN FUNCTIONS ============

    /// @notice Initiate oracle change (24 hour delay for security)
    function initiateOracleChange(address _newOracle) external onlyOwner {
        require(_newOracle != address(0), "Invalid oracle address");
        require(_newOracle != oracle, "Same oracle");

        pendingOracle = _newOracle;
        oracleChangeTimestamp = block.timestamp + ORACLE_CHANGE_DELAY;

        emit OracleChangeInitiated(oracle, _newOracle, oracleChangeTimestamp);
    }

    /// @notice Complete oracle change after delay
    function completeOracleChange() external onlyOwner {
        require(pendingOracle != address(0), "No pending oracle");
        require(block.timestamp >= oracleChangeTimestamp, "Delay not passed");

        address oldOracle = oracle;
        oracle = pendingOracle;
        pendingOracle = address(0);
        oracleChangeTimestamp = 0;

        emit OracleChangeCompleted(oldOracle, oracle);
    }

    /// @notice Cancel pending oracle change
    function cancelOracleChange() external onlyOwner {
        require(pendingOracle != address(0), "No pending oracle");

        address cancelled = pendingOracle;
        pendingOracle = address(0);
        oracleChangeTimestamp = 0;

        emit OracleChangeCancelled(cancelled);
    }

    /// @notice Update treasury address
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury address");
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    /// @notice Pause contract in emergency
    function pause() external onlyOwner {
        _pause();
        emit ContractPaused(msg.sender);
    }

    /// @notice Unpause contract
    function unpause() external onlyOwner {
        _unpause();
        emit ContractUnpaused(msg.sender);
    }
}
