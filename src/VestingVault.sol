// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title VestingVault — token vesting with cliff, linear unlock and revocation (STUDENT STARTER)
/// @notice One vault holds tokens for many beneficiaries. The owner (e.g. the project team)
///         creates schedules; beneficiaries (team, investors, advisors) receive tokens over time.
contract VestingVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================
    //  PROVIDED PART (identical to the student starter file)
    // ============================================================
    struct Schedule {
        address beneficiary;
        uint256 total;      // total tokens promised
        uint256 released;   // tokens already paid out
        uint64 start;       // unix time when vesting starts
        uint64 cliff;       // seconds after `start` before ANY token vests
        uint64 duration;    // seconds after `start` when 100% is vested
        uint64 revokedAt;   // 0 while not revoked
        bool revocable;
        bool revoked;
    }

    IERC20 public immutable token;
    uint256 public scheduleCount;                       // ids start from 1
    uint256 public totalAllocated;                      // tokens promised to beneficiaries and not yet paid out
    mapping(uint256 => Schedule) public schedules;
    mapping(address => uint256[]) private _schedulesOf;

    event ScheduleCreated(uint256 indexed id, address indexed beneficiary, uint256 amount, uint64 start, uint64 cliff, uint64 duration, bool revocable);
    event Released(uint256 indexed id, address indexed beneficiary, uint256 amount);
    event Revoked(uint256 indexed id, uint256 returnedToOwner);
    event ScheduleTransferred(uint256 indexed id, address indexed from, address indexed to);

    constructor(IERC20 token_) Ownable(msg.sender) {
        require(address(token_) != address(0), "zero token");
        token = token_;
    }

    // ============================================================
    //  YOUR CODE STARTS HERE
    // ============================================================

    // ------------------------------------------------------------
    // STEP 1 — create a schedule (owner only)
    // Validate: beneficiary != 0, amount > 0, duration > 0, cliff <= duration,
    //   and the vault must hold enough NOT-YET-PROMISED tokens:
    //   token.balanceOf(address(this)) - totalAllocated >= amount
    // Then: id = ++scheduleCount, store the Schedule (released = 0, revokedAt = 0, revoked = false),
    //   remember the id in _schedulesOf[beneficiary], totalAllocated += amount,
    //   emit ScheduleCreated. Return the id.
    // ------------------------------------------------------------
    /// @notice Reserves vault tokens for a new vesting schedule.
    /// @param beneficiary Address that receives vested tokens.
    /// @param amount Total allocation in the token's smallest units.
    /// @param start Vesting start as a Unix timestamp in seconds.
    /// @param cliff Seconds from the start until the first unlock.
    /// @param duration Seconds from the start until full vesting.
    /// @param revocable Whether the vault owner can revoke unvested tokens.
    /// @return id Identifier of the new schedule.
    function createSchedule(
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 cliff,
        uint64 duration,
        bool revocable
    ) external onlyOwner returns (uint256 id) {
        require(beneficiary != address(0), "zero beneficiary");
        require(amount > 0, "zero amount");
        require(duration > 0, "zero duration");
        require(cliff <= duration, "cliff exceeds duration");

        uint256 balance = token.balanceOf(address(this));
        require(
            balance >= totalAllocated && balance - totalAllocated >= amount,
            "insufficient unallocated tokens"
        );

        id = ++scheduleCount;
        schedules[id] = Schedule({
            beneficiary: beneficiary,
            total: amount,
            released: 0,
            start: start,
            cliff: cliff,
            duration: duration,
            revokedAt: 0,
            revocable: revocable,
            revoked: false
        });
        _schedulesOf[beneficiary].push(id);
        totalAllocated += amount;

        emit ScheduleCreated(id, beneficiary, amount, start, cliff, duration, revocable);
    }

    /// @notice Returns the total vested amount, including past payouts.
    /// @param id Schedule identifier.
    /// @return Total vested amount in the token's smallest units.
    function vestedAmount(uint256 id) public view returns (uint256) {
        Schedule storage s = schedules[id];
        require(s.beneficiary != address(0), "unknown schedule");
        return _vested(s);
    }

    /// @notice Returns the amount currently available to release.
    /// @param id Schedule identifier.
    /// @return Vested tokens that have yet to be paid.
    function releasable(uint256 id) public view returns (uint256) {
        return vestedAmount(id) - schedules[id].released;
    }

    /// @notice Sends currently payable tokens to the schedule beneficiary.
    /// @param id Schedule identifier.
    function release(uint256 id) external nonReentrant {
        uint256 amount = releasable(id);
        require(amount > 0, "nothing to release");

        Schedule storage s = schedules[id];
        address beneficiary = s.beneficiary;
        s.released += amount;
        totalAllocated -= amount;

        token.safeTransfer(beneficiary, amount);
        emit Released(id, beneficiary, amount);
    }

    /// @notice Freezes vesting and returns unvested tokens to the owner.
    /// @param id Schedule identifier.
    function revoke(uint256 id) external onlyOwner nonReentrant {
        Schedule storage s = schedules[id];
        require(s.beneficiary != address(0), "unknown schedule");
        require(s.revocable, "schedule is irrevocable");
        require(!s.revoked, "already revoked");

        uint256 returnedAmount = s.total - _vested(s);
        s.revoked = true;
        s.revokedAt = uint64(block.timestamp);
        totalAllocated -= returnedAmount;

        if (returnedAmount > 0) {
            token.safeTransfer(msg.sender, returnedAmount);
        }
        emit Revoked(id, returnedAmount);
    }

    /// @notice Withdraws the vault balance in excess of its obligations.
    /// @param to Recipient of the unallocated tokens.
    /// @return amount Amount withdrawn in the token's smallest units.
    function withdrawUnallocated(address to)
        external
        onlyOwner
        nonReentrant
        returns (uint256 amount)
    {
        require(to != address(0), "zero recipient");
        uint256 balance = token.balanceOf(address(this));
        require(balance > totalAllocated, "nothing to withdraw");

        amount = balance - totalAllocated;
        token.safeTransfer(to, amount);
    }

    /// @notice Returns the IDs assigned to a beneficiary.
    /// @param beneficiary Address whose schedules are requested.
    /// @return Schedule IDs in their current storage order.
    function schedulesOf(address beneficiary) external view returns (uint256[] memory) {
        return _schedulesOf[beneficiary];
    }

    /// @notice Assigns the schedule and its remaining payouts to a new beneficiary.
    /// @param id Schedule identifier.
    /// @param newBeneficiary Address that will receive future payouts.
    function transferSchedule(uint256 id, address newBeneficiary) external {
        Schedule storage s = schedules[id];
        address previousBeneficiary = s.beneficiary;
        require(previousBeneficiary == msg.sender, "not beneficiary");
        require(newBeneficiary != address(0), "zero beneficiary");

        if (newBeneficiary != previousBeneficiary) {
            uint256[] storage previousIds = _schedulesOf[previousBeneficiary];
            for (uint256 i = 0; i < previousIds.length; i++) {
                if (previousIds[i] == id) {
                    previousIds[i] = previousIds[previousIds.length - 1];
                    previousIds.pop();
                    break;
                }
            }
            s.beneficiary = newBeneficiary;
            _schedulesOf[newBeneficiary].push(id);
        }

        emit ScheduleTransferred(id, previousBeneficiary, newBeneficiary);
    }

    function _vested(Schedule storage s) internal view returns (uint256) {
        uint256 time = s.revoked ? s.revokedAt : block.timestamp;
        uint256 start = s.start;

        if (time < start + s.cliff) {
            return 0;
        }
        if (time >= start + s.duration) {
            return s.total;
        }
        return Math.mulDiv(s.total, time - start, s.duration);
    }
}