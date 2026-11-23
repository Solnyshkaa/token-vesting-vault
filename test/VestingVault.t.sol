// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {VestingVault} from "../src/VestingVault.sol";

contract TestToken is ERC20 {
    constructor() ERC20("Test Token", "TST") {
        _mint(msg.sender, 1_000_000);
    }
}

contract VestingVaultTest is Test {
    TestToken private token;
    VestingVault private vault;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    uint64 private constant START = 10_000;
    uint64 private constant CLIFF = 200;
    uint64 private constant DURATION = 1_000;
    uint256 private constant TOTAL = 1_000;
    uint256 private constant FUNDING = 1_500;

    function setUp() public {
        vm.warp(START - 10);
        token = new TestToken();
        vault = new VestingVault(token);
        token.transfer(address(vault), FUNDING);
    }

    function _create(bool revocable) private returns (uint256) {
        return vault.createSchedule(ALICE, TOTAL, START, CLIFF, DURATION, revocable);
    }

    function testBeforeStart() public {
        uint256 id = _create(true);
        assertEq(vault.vestedAmount(id), 0);
    }

    function testDuringCliff() public {
        uint256 id = _create(true);
        vm.warp(START + CLIFF - 1);
        assertEq(vault.vestedAmount(id), 0);
    }

    function testExactlyAtCliff() public {
        uint256 id = _create(true);
        vm.warp(START + CLIFF);
        assertEq(vault.vestedAmount(id), 200);
    }

    function testHalfway() public {
        uint256 id = _create(true);
        vm.warp(START + 500);
        assertEq(vault.vestedAmount(id), 500);
    }

    function testExactlyAtEnd() public {
        uint256 id = _create(true);
        vm.warp(START + DURATION);
        assertEq(vault.vestedAmount(id), TOTAL);
    }

    function testAfterEnd() public {
        uint256 id = _create(true);
        vm.warp(START + DURATION + 1);
        assertEq(vault.vestedAmount(id), TOTAL);
    }

    function testSeveralReleasesSumToTotal() public {
        uint256 id = _create(true);

        vm.warp(START + CLIFF);
        vault.release(id);
        assertEq(token.balanceOf(ALICE), 200);
        assertEq(vault.totalAllocated(), 800);

        vm.warp(START + 500);
        vault.release(id);
        assertEq(token.balanceOf(ALICE), 500);

        vm.warp(START + DURATION);
        vault.release(id);
        assertEq(token.balanceOf(ALICE), TOTAL);
        assertEq(vault.totalAllocated(), 0);

        vm.expectRevert(bytes("nothing to release"));
        vault.release(id);
    }

    function testRevokeBeforeCliff() public {
        uint256 id = _create(true);
        vm.warp(START + CLIFF - 1);
        uint256 ownerBalance = token.balanceOf(address(this));

        vault.revoke(id);
        assertEq(token.balanceOf(address(this)), ownerBalance + TOTAL);
        assertEq(vault.totalAllocated(), 0);

        vm.warp(START + DURATION);
        assertEq(vault.releasable(id), 0);
    }

    function testRevokeHalfwayPreservesOnlyUnpaidVestedTokens() public {
        uint256 id = _create(true);
        vm.warp(START + CLIFF);
        vault.release(id);

        vm.warp(START + 500);
        uint256 ownerBalance = token.balanceOf(address(this));
        vault.revoke(id);
        assertEq(token.balanceOf(address(this)), ownerBalance + 500);
        assertEq(vault.totalAllocated(), 300);

        vm.warp(START + DURATION + 10_000);
        assertEq(vault.vestedAmount(id), 500);
        assertEq(vault.releasable(id), 300);
        vault.release(id);
        assertEq(token.balanceOf(ALICE), 500);
        assertEq(vault.totalAllocated(), 0);
    }

    function testRevokeAfterEndReturnsZero() public {
        uint256 id = _create(true);
        vm.warp(START + DURATION + 1);
        uint256 ownerBalance = token.balanceOf(address(this));

        vault.revoke(id);
        assertEq(token.balanceOf(address(this)), ownerBalance);
        assertEq(vault.releasable(id), TOTAL);
        assertEq(vault.totalAllocated(), TOTAL);
    }

    function testCannotAllocateMoreThanFreeBalance() public {
        _create(true);
        vm.expectRevert(bytes("insufficient unallocated tokens"));
        vault.createSchedule(BOB, 501, START, CLIFF, DURATION, true);
    }

    function testNonOwnerCannotCreate() public {
        vm.expectRevert();
        vm.prank(BOB);
        vault.createSchedule(BOB, TOTAL, START, CLIFF, DURATION, true);
    }

    function testNonOwnerCannotRevoke() public {
        uint256 id = _create(true);
        vm.expectRevert();
        vm.prank(BOB);
        vault.revoke(id);
    }

    function testAnyoneCanReleaseButOnlyBeneficiaryGetsTokens() public {
        uint256 id = _create(true);
        vm.warp(START + CLIFF);
        vm.prank(BOB);
        vault.release(id);

        assertEq(token.balanceOf(ALICE), 200);
        assertEq(token.balanceOf(BOB), 0);
    }

    function testCannotRevokeIrrevocableSchedule() public {
        uint256 id = _create(false);
        vm.expectRevert(bytes("schedule is irrevocable"));
        vault.revoke(id);
    }

    function testWithdrawOnlyUnallocatedTokens() public {
        _create(true);
        assertEq(vault.withdrawUnallocated(BOB), 500);
        assertEq(token.balanceOf(BOB), 500);
        assertEq(token.balanceOf(address(vault)), TOTAL);
        assertEq(vault.totalAllocated(), TOTAL);
    }

    function testTransferUpdatesListsAndPreservesPastPayout() public {
        uint256 id = _create(true);
        vm.warp(START + CLIFF);
        vault.release(id);

        vm.prank(ALICE);
        vault.transferSchedule(id, BOB);
        assertEq(vault.schedulesOf(ALICE).length, 0);
        uint256[] memory bobIds = vault.schedulesOf(BOB);
        assertEq(bobIds.length, 1);
        assertEq(bobIds[0], id);

        vm.warp(START + DURATION);
        vault.release(id);
        assertEq(token.balanceOf(ALICE), 200);
        assertEq(token.balanceOf(BOB), 800);
    }

    function testRoundsDownAndPaysRemainderAtEnd() public {
        uint256 id = vault.createSchedule(ALICE, 1000, START, 0, 3, false);

        vm.warp(START + 1);
        assertEq(vault.vestedAmount(id), 333);
        vm.warp(START + 2);
        assertEq(vault.vestedAmount(id), 666);
        vm.warp(START + 3);
        assertEq(vault.vestedAmount(id), 1000);
    }

    function testFuzzVestingNeverDecreasesOrExceedsTotal(
        uint256 rawAmount,
        uint256 rawTimeA,
        uint256 rawTimeB
    ) public {
        uint256 amount = bound(rawAmount, 1, FUNDING);
        uint256 firstTime = bound(rawTimeA, START - 10, START + 2_000);
        uint256 secondTime = bound(rawTimeB, firstTime, START + 2_000);
        uint256 id = vault.createSchedule(ALICE, amount, START, CLIFF, DURATION, false);

        vm.warp(firstTime);
        uint256 firstVested = vault.vestedAmount(id);
        vm.warp(secondTime);
        uint256 secondVested = vault.vestedAmount(id);

        assertLe(firstVested, secondVested);
        assertLe(secondVested, amount);
    }
}