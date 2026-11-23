import { Contract, isAddress, JsonRpcProvider, ZeroAddress } from "ethers";
import "./style.css";

const element = (id) => document.getElementById(id);
const form = element("create");
const selector = element("schedule");
const provider = new JsonRpcProvider(location.origin + "/rpc", undefined, {
    cacheTimeout: -1,
});
let deployment;
let vault;
let token;
let busy = false;
let ready = false;
let selected;
let available = 0n;

function message(text, error = false) {
    element("status").textContent = text;
    element("status").classList.toggle("error", error);
}

function setControls() {
    const locked = busy || !ready;
    element("create-button").disabled = locked;
    element("advance").disabled = locked;
    element("refresh").disabled = locked;
    selector.disabled = locked || !selector.value;
    element("release").disabled = locked || available === 0n;
    element("revoke").disabled = locked || !selected?.revocable || selected.revoked;
}

function scheduleOption(label, value) {
    const option = document.createElement("option");
    option.textContent = label;
    option.value = value;
    return option;
}

async function refresh(preferredId = selector.value) {
    const block = await provider.getBlock("latest");
    const atBlock = { blockTag: block.number };
    const [count, balance, allocated] = await Promise.all([
        vault.scheduleCount(atBlock),
        token.balanceOf(deployment.vault.address, atBlock),
        vault.totalAllocated(atBlock),
    ]);
    const options = [];
    for (let id = 1n; id <= count; id++) {
        options.push(scheduleOption("#" + id, String(id)));
    }
    selector.replaceChildren(...(options.length ? options : [scheduleOption("No schedules", "")]));
    selector.value = options.some((option) => option.value === preferredId)
        ? preferredId
        : (options[0]?.value ?? "");

    selected = undefined;
    available = 0n;
    let vested = 0n;
    if (selector.value) {
        [selected, vested, available] = await Promise.all([
            vault.schedules(selector.value, atBlock),
            vault.vestedAmount(selector.value, atBlock),
            vault.releasable(selector.value, atBlock),
        ]);
    }

    const recipient = selected?.beneficiary ?? deployment.beneficiary;
    const recipientBalance = await token.balanceOf(recipient, atBlock);
    element("vault-balance").textContent = balance + " DEMO";
    element("free-balance").textContent = (balance - allocated) + " DEMO";
    element("beneficiary-balance").textContent = recipientBalance + " DEMO";
    element("recipient").textContent = selected
        ? "Recipient " + recipient
        : "Create a schedule to see its recipient.";
    element("total").textContent = selected?.total.toString() ?? "—";
    element("vested").textContent = selected ? vested.toString() : "—";
    element("released").textContent = selected?.released.toString() ?? "—";
    element("releasable").textContent = selected ? available.toString() : "—";

    const percent = selected ? Number(vested * 100n / selected.total) : 0;
    const bar = element("progress-fill");
    bar.style.width = percent + "%";
    bar.parentElement.setAttribute("aria-valuenow", String(percent));
    const time = BigInt(block.timestamp);
    let state = "";
    if (selected?.revoked) state = "Revoked. Vesting is frozen.";
    else if (selected && time < selected.start + selected.cliff) state = "Cliff period";
    else if (selected && time >= selected.start + selected.duration) state = "Fully vested";
    else if (selected) state = "Vesting in progress";
    element("schedule-state").textContent = state;
}

async function act(action) {
    if (busy || !ready) return;
    busy = true;
    setControls();
    message("Working…");
    try {
        message(await action());
    } catch (error) {
        message(error.reason ?? error.shortMessage ?? error.message, true);
    } finally {
        busy = false;
        setControls();
    }
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    void act(async () => {
        const data = new FormData(form);
        const recipient = data.get("beneficiary").trim();
        const amount = BigInt(data.get("amount"));
        const cliff = BigInt(data.get("cliff"));
        const duration = BigInt(data.get("duration"));
        if (!isAddress(recipient) || recipient === ZeroAddress) {
            throw new Error("Enter a valid beneficiary address.");
        }
        if (cliff > duration) throw new Error("Cliff must be at most the duration.");
        const latest = await provider.getBlock("latest");
        const start = Math.max(latest.timestamp + 1, Math.floor(Date.now() / 1000));
        await provider.send("evm_setNextBlockTimestamp", [start]);
        const transaction = await vault.createSchedule(
            recipient, amount, start, cliff, duration, data.has("revocable"),
        );
        const receipt = await transaction.wait();
        const created = receipt.logs.map((log) => vault.interface.parseLog(log))
            .find((event) => event?.name === "ScheduleCreated");
        const id = created.args.id.toString();
        await refresh(id);
        return "Created schedule #" + id + ".";
    });
});

selector.addEventListener("change", () => act(async () => {
    await refresh();
    return "Showing schedule #" + selector.value + ".";
}));

element("release").addEventListener("click", () => act(async () => {
    const receipt = await (await vault.release(selector.value)).wait();
    const event = receipt.logs.map((log) => vault.interface.parseLog(log))
        .find((log) => log?.name === "Released");
    await refresh();
    return "Released " + event.args.amount + " DEMO to the beneficiary.";
}));

element("revoke").addEventListener("click", () => act(async () => {
    await provider.send("evm_setNextBlockTimestamp", [(await provider.getBlock("latest")).timestamp + 1]);
    const receipt = await (await vault.revoke(selector.value)).wait();
    const event = receipt.logs.map((log) => vault.interface.parseLog(log))
        .find((log) => log?.name === "Revoked");
    await refresh();
    return "Schedule revoked. " + event.args.returnedToOwner + " DEMO returned to the owner.";
}));

element("advance").addEventListener("click", () => act(async () => {
    const block = await provider.getBlock("latest");
    await provider.send("evm_setNextBlockTimestamp", [block.timestamp + 1800]);
    await provider.send("evm_mine", []);
    await refresh();
    return "Mined a block 30 minutes ahead.";
}));

element("refresh").addEventListener("click", () => act(async () => {
    await refresh();
    return "Updated from the latest block.";
}));

try {
    const response = await fetch("/deployment.json", { cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
        throw new Error("Run npm run deploy:local and reload this page.");
    }
    deployment = await response.json();
    const deploymentReceipt = await provider.getTransactionReceipt(deployment.deploymentHash);
    if (!deploymentReceipt) throw new Error("Deployment missing from this node. Redeploy and reload.");
    const owner = await provider.getSigner(deployment.owner);
    vault = new Contract(deployment.vault.address, deployment.vault.abi, owner);
    token = new Contract(deployment.token.address, deployment.token.abi, provider);
    element("beneficiary").value = deployment.beneficiary;
    element("deployment").textContent = "Vault " + deployment.vault.address;
    await refresh();
    ready = true;
    element("connection").textContent = "Hardhat · localhost";
    message("Ready. Transactions use the local owner account.");
} catch (error) {
    element("connection").textContent = "Disconnected";
    message(error.shortMessage ?? error.message, true);
}
setControls();
