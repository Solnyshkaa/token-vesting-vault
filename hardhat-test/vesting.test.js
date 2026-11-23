import assert from "node:assert/strict";
import { test } from "node:test";
import hre from "hardhat";
import { BrowserProvider, ContractFactory, ZeroAddress } from "ethers";

const [tokenArtifact, vaultArtifact] = await Promise.all([
    hre.artifacts.readArtifact("DemoToken"),
    hre.artifacts.readArtifact("VestingVault"),
]);

async function setup(t) {
    const connection = await hre.network.create();
    const provider = new BrowserProvider(connection.provider, undefined, {
        cacheTimeout: -1,
    });
    t.after(async () => {
        provider.destroy();
        await connection.close();
    });

    const owner = await provider.getSigner(0);
    const beneficiary = await provider.getSigner(1);
    const thirdParty = await provider.getSigner(2);

    const token = await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, owner).deploy();
    await token.waitForDeployment();
    const vault = await new ContractFactory(vaultArtifact.abi, vaultArtifact.bytecode, owner)
        .deploy(await token.getAddress());
    await vault.waitForDeployment();
    await (await token.transfer(await vault.getAddress(), 1500n)).wait();

    const start = (await provider.getBlock("latest")).timestamp + 60;
    const create = (overrides = {}) => {
        const schedule = {
            beneficiary: beneficiary.address,
            amount: 1000n,
            start,
            cliff: 300,
            duration: 3600,
            revocable: true,
            ...overrides,
        };
        return vault.createSchedule(
            schedule.beneficiary, schedule.amount, schedule.start,
            schedule.cliff, schedule.duration, schedule.revocable,
        );
    };

    async function warp(offset) {
        await provider.send("evm_setNextBlockTimestamp", [start + offset]);
        await provider.send("evm_mine", []);
    }

    return { vault, token, owner, beneficiary, thirdParty, start, create, warp };
}

test("deployment sets the token and owner and funds the vault", async (t) => {
    const { vault, token, owner } = await setup(t);
    assert.equal(await vault.owner(), owner.address);
    assert.equal(await vault.token(), await token.getAddress());
    assert.equal(await token.balanceOf(await vault.getAddress()), 1500n);
    assert.equal(await vault.totalAllocated(), 0n);
});

test("creating a schedule reserves tokens and lists its ID", async (t) => {
    const { vault, beneficiary, create } = await setup(t);
    await (await create()).wait();
    assert.equal(await vault.scheduleCount(), 1n);
    assert.deepEqual(Array.from(await vault.schedulesOf(beneficiary.address)), [1n]);
    assert.equal(await vault.totalAllocated(), 1000n);
});

test("nothing vests before start or before the cliff ends", async (t) => {
    const { vault, create, warp } = await setup(t);
    await (await create()).wait();
    assert.equal(await vault.releasable(1), 0n);
    await warp(299);
    assert.equal(await vault.vestedAmount(1), 0n);
});

test("vesting includes elapsed time from start at the cliff boundary", async (t) => {
    const { vault, create, warp } = await setup(t);
    await (await create()).wait();
    await warp(300);
    assert.equal(await vault.vestedAmount(1), 83n);
    await warp(1800);
    assert.equal(await vault.vestedAmount(1), 500n);
});

test("vesting is capped at the total", async (t) => {
    const { vault, create, warp } = await setup(t);
    await (await create()).wait();
    await warp(3600);
    assert.equal(await vault.vestedAmount(1), 1000n);
    await warp(7200);
    assert.equal(await vault.vestedAmount(1), 1000n);
});

test("a third party can release tokens only to the beneficiary", async (t) => {
    const { vault, token, beneficiary, thirdParty, create, warp } = await setup(t);
    await (await create()).wait();
    await warp(1800);
    await (await vault.connect(thirdParty).release(1)).wait();
    const paid = await token.balanceOf(beneficiary.address);
    assert.ok(paid > 0n && paid < 1000n);
    assert.equal(await token.balanceOf(thirdParty.address), 0n);
    assert.equal((await vault.schedules(1)).released, paid);
    assert.equal(await vault.totalAllocated(), 1000n - paid);
    await warp(3600);
    await (await vault.release(1)).wait();
    assert.equal(await token.balanceOf(beneficiary.address), 1000n);
    assert.equal(await vault.totalAllocated(), 0n);
    await assert.rejects(vault.release.staticCall(1), /nothing to release/);
});

test("revocation freezes vesting and returns only unvested tokens", async (t) => {
    const { vault, token, owner, beneficiary, create, start, warp } = await setup(t);
    await (await create()).wait();
    await vault.runner.provider.send("evm_setNextBlockTimestamp", [start + 1800]);
    await (await vault.revoke(1)).wait();
    assert.equal(await token.balanceOf(owner.address), 500n);
    assert.equal(await vault.totalAllocated(), 500n);
    assert.equal((await vault.schedules(1)).revoked, true);
    await warp(7200);
    assert.equal(await vault.vestedAmount(1), 500n);
    await (await vault.release(1)).wait();
    assert.equal(await token.balanceOf(beneficiary.address), 500n);
    assert.equal(await vault.releasable(1), 0n);
});

test("revocation during the cliff returns the whole allocation", async (t) => {
    const { vault, token, owner, create } = await setup(t);
    await (await create()).wait();
    await (await vault.revoke(1)).wait();
    assert.equal(await token.balanceOf(owner.address), 1000n);
    assert.equal(await vault.totalAllocated(), 0n);
    assert.equal(await vault.releasable(1), 0n);
});

test("only the owner can create or revoke and an irrevocable schedule stays active", async (t) => {
    const { vault, beneficiary, thirdParty, start, create } = await setup(t);
    const unauthorizedVault = vault.connect(thirdParty);
    await assert.rejects(
        unauthorizedVault.createSchedule.staticCall(beneficiary.address, 1000n, start, 300, 3600, true),
        /OwnableUnauthorizedAccount/,
    );
    await (await create({ revocable: false })).wait();
    await assert.rejects(unauthorizedVault.revoke.staticCall(1), /OwnableUnauthorizedAccount/);
    await assert.rejects(vault.revoke.staticCall(1), /schedule is irrevocable/);
});

test("invalid inputs and allocations above the free balance are rejected", async (t) => {
    const { vault, beneficiary, start, create } = await setup(t);
    const createCall = vault.createSchedule.staticCall;
    await assert.rejects(createCall(ZeroAddress, 1000n, start, 300, 3600, true), /zero beneficiary/);
    await assert.rejects(createCall(beneficiary.address, 1000n, start, 3601, 3600, true), /cliff exceeds duration/);
    await (await create()).wait();
    await assert.rejects(
        createCall(beneficiary.address, 501n, start, 300, 3600, true),
        /insufficient unallocated tokens/,
    );
});

test("withdrawal leaves allocated funds in the vault", async (t) => {
    const { vault, token, owner, create } = await setup(t);
    await (await create()).wait();
    await (await vault.withdrawUnallocated(owner.address)).wait();
    assert.equal(await token.balanceOf(owner.address), 500n);
    assert.equal(await token.balanceOf(await vault.getAddress()), 1000n);
    assert.equal(await vault.totalAllocated(), 1000n);
});

test("schedule transfer updates the recipient of future payouts", async (t) => {
    const { vault, token, beneficiary, thirdParty, create, warp } = await setup(t);
    await (await create()).wait();
    await (await vault.connect(beneficiary).transferSchedule(1, thirdParty.address)).wait();
    assert.deepEqual(Array.from(await vault.schedulesOf(beneficiary.address)), []);
    assert.deepEqual(Array.from(await vault.schedulesOf(thirdParty.address)), [1n]);
    await warp(3600);
    await (await vault.release(1)).wait();
    assert.equal(await token.balanceOf(beneficiary.address), 0n);
    assert.equal(await token.balanceOf(thirdParty.address), 1000n);
});
