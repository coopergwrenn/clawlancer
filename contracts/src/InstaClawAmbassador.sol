// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title InstaClaw Ambassador — Soulbound ERC-721
 * @notice Non-transferable badge minted to InstaClaw ambassadors on Base.
 *         Only the contract owner can mint and burn. All transfers revert.
 */
contract InstaClawAmbassador is ERC721, Ownable {
    // ── On-chain metadata per ambassador ──
    struct Ambassador {
        string name;
        uint32 number;
        uint64 dateIssued; // unix timestamp
    }

    mapping(uint256 => Ambassador) private _ambassadors;
    uint256 private _nextTokenId;
    string private _baseImageURI;

    // ── Events ──
    event BadgeMinted(uint256 indexed tokenId, address indexed to, string name, uint32 number);
    event BadgeBurned(uint256 indexed tokenId, address indexed from);
    event BaseImageURIUpdated(string newURI);

    constructor(address initialOwner)
        ERC721("InstaClaw Ambassador", "ICAMBASSADOR")
        Ownable(initialOwner)
    {
        _nextTokenId = 1; // token IDs start at 1
    }

    // ── Soulbound: block all transfers ──

    /**
     * @dev Override _update to enforce soulbound constraint.
     *      Only mint (from == address(0)) and burn (to == address(0)) are allowed.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);

        // Allow mint (from == 0) and burn (to == 0), block everything else
        if (from != address(0) && to != address(0)) {
            revert("Soulbound: transfers disabled");
        }

        return super._update(to, tokenId, auth);
    }

    // ── Mint & Burn ──

    /**
     * @notice Mint a soulbound ambassador badge.
     * @param to        Recipient wallet address.
     * @param name      Ambassador's display name.
     * @param number    Sequential ambassador number (e.g. 1, 2, 3...).
     * @return tokenId  The newly minted token ID.
     */
    function mintBadge(
        address to,
        string calldata name,
        uint32 number
    ) external onlyOwner returns (uint256) {
        require(to != address(0), "Cannot mint to zero address");
        require(bytes(name).length > 0, "Name cannot be empty");
        require(number > 0, "Number must be positive");

        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);

        _ambassadors[tokenId] = Ambassador({
            name: name,
            number: number,
            dateIssued: uint64(block.timestamp)
        });

        emit BadgeMinted(tokenId, to, name, number);
        return tokenId;
    }

    /**
     * @notice Burn (revoke) a soulbound ambassador badge.
     * @param tokenId The token to burn.
     */
    function burnBadge(uint256 tokenId) external onlyOwner {
        address holder = ownerOf(tokenId); // reverts if nonexistent
        emit BadgeBurned(tokenId, holder);
        _burn(tokenId);
        delete _ambassadors[tokenId];
    }

    // ── Views ──

    /**
     * @notice Get on-chain ambassador metadata.
     * @param tokenId The ambassador badge token ID.
     * @return name        Ambassador display name.
     * @return number      Sequential ambassador number.
     * @return dateIssued  Unix timestamp of mint date.
     * @return holder      Current wallet address.
     */
    function getAmbassador(uint256 tokenId)
        external
        view
        returns (
            string memory name,
            uint32 number,
            uint64 dateIssued,
            address holder
        )
    {
        holder = ownerOf(tokenId); // reverts if nonexistent
        Ambassador storage a = _ambassadors[tokenId];
        return (a.name, a.number, a.dateIssued, holder);
    }

    /**
     * @notice Set the base image URI for badge artwork.
     * @param newBaseImageURI The new base URI (token ID will NOT be appended —
     *        set the full URI if all badges share one image, or use a gateway).
     */
    function setBaseImageURI(string calldata newBaseImageURI) external onlyOwner {
        _baseImageURI = newBaseImageURI;
        emit BaseImageURIUpdated(newBaseImageURI);
    }

    /**
     * @notice Returns base64-encoded JSON metadata for a given token.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        ownerOf(tokenId); // reverts if nonexistent

        Ambassador storage a = _ambassadors[tokenId];
        string memory num = _toString(uint256(a.number));
        string memory paddedNum = _padNumber(a.number);
        string memory issued = _toString(uint256(a.dateIssued));

        // Build image URI — use baseImageURI if set, otherwise empty
        string memory imageURI = bytes(_baseImageURI).length > 0
            ? _baseImageURI
            : "";

        // Build JSON
        bytes memory json = abi.encodePacked(
            '{"name":"InstaClaw Ambassador #',
            paddedNum,
            '","description":"Soulbound ambassador badge for InstaClaw. Non-transferable."',
            ',"image":"',
            imageURI,
            '","attributes":[',
            '{"trait_type":"Ambassador Name","value":"',
            a.name,
            '"},{"trait_type":"Ambassador Number","display_type":"number","value":',
            num,
            '},{"trait_type":"Date Issued","display_type":"date","value":',
            issued,
            '}]}'
        );

        return string(
            abi.encodePacked(
                "data:application/json;base64,",
                Base64.encode(json)
            )
        );
    }

    /**
     * @notice Total badges minted (includes burned — use for next-ID tracking).
     */
    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    // ── Internal helpers ──

    /// @dev uint256 to decimal string (avoids Strings.sol which requires solc >=0.8.24)
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /// @dev Zero-pad ambassador number to 3 digits (e.g. 1 → "001", 42 → "042")
    function _padNumber(uint32 num) internal pure returns (string memory) {
        if (num >= 100) return _toString(uint256(num));
        if (num >= 10) return string(abi.encodePacked("0", _toString(uint256(num))));
        return string(abi.encodePacked("00", _toString(uint256(num))));
    }
}
