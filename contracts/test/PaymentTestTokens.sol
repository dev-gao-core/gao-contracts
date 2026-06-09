// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test-only ERC-20 variants for GaoDomainPaymentV1 unit tests. NONE of
// these are intended for deployment — they live under contracts/test/ so
// deploy scripts that filter production sources skip them naturally.
//
//   * NoReturnERC20   — USDT-style: transfer/transferFrom/approve return
//                       NOTHING. Proves SafeERC20 treats an empty return
//                       as success.
//   * FalseReturnERC20 — transferFrom returns `false`. Proves SafeERC20
//                       reverts with SafeERC20FailedOperation.
//   * ReentrantERC20  — transferFrom re-enters payForDomain. Proves the
//                       `nonReentrant` guard fires
//                       (ReentrancyGuardReentrantCall).

/// @dev Minimal interface to re-enter the payment contract.
interface IGaoDomainPaymentV1Reenter {
    function payForDomain(
        bytes32 invoiceId,
        bytes32 domainHash,
        string calldata domainName,
        address token,
        uint256 amount,
        string calldata profileURI,
        bytes32 profileHash
    ) external;
}

/// @title NoReturnERC20
/// @notice USDT-style token whose mutating methods return no value.
contract NoReturnERC20 {
    string public name = "No Return USD";
    string public symbol = "USDTNR";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    // No return value — the SafeERC20 wrapper must accept this.
    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        emit Transfer(from, to, amount);
    }
}

/// @title FalseReturnERC20
/// @notice Token whose transferFrom silently returns `false` (no revert).
///         SafeERC20 must convert this into a revert.
contract FalseReturnERC20 {
    string public name = "False Return USD";
    string public symbol = "USDFR";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @title ReentrantERC20
/// @notice On `transferFrom`, re-enters `payForDomain` on the configured
///         payment contract. The re-entrant call must be rejected by the
///         payment contract's `nonReentrant` guard.
contract ReentrantERC20 {
    string public name = "Reentrant USD";
    string public symbol = "USDRE";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public payment;
    bool private _reentered;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setPayment(address p) external {
        payment = p;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        // Attempt to re-enter once. The payment contract's nonReentrant
        // guard must revert this inner call; that revert bubbles up and
        // fails the whole purchase tx.
        if (payment != address(0) && !_reentered) {
            _reentered = true;
            IGaoDomainPaymentV1Reenter(payment).payForDomain(
                keccak256("reenter-invoice"),
                keccak256(bytes("reenter.gao")),
                "reenter.gao",
                address(this),
                1,
                "ipfs://reenter",
                keccak256("reenter-profile")
            );
        }
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
