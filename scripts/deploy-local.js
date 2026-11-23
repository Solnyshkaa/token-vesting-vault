import { mkdir, writeFile } from "node:fs/promises";
import hre from "hardhat";
import { ContractFactory, JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("http://127.0.0.1:8545", undefined, {
    cacheTimeout: -1,
});
const owner = await provider.getSigner(0);
const beneficiary = await provider.getSigner(1);
const tokenArtifact = await hre.artifacts.readArtifact("DemoToken");
const vaultArtifact = await hre.artifacts.readArtifact("VestingVault");

const token = await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, owner).deploy();
await token.waitForDeployment();
const tokenAddress = await token.getAddress();

const vault = await new ContractFactory(vaultArtifact.abi, vaultArtifact.bytecode, owner)
    .deploy(tokenAddress);
await vault.waitForDeployment();
const vaultAddress = await vault.getAddress();
await (await token.transfer(vaultAddress, 1500)).wait();

const deployment = {
    owner: await owner.getAddress(),
    beneficiary: await beneficiary.getAddress(),
    deploymentHash: vault.deploymentTransaction().hash,
    token: { address: tokenAddress, abi: tokenArtifact.abi },
    vault: { address: vaultAddress, abi: vaultArtifact.abi },
};
await mkdir("public", { recursive: true });
await writeFile("public/deployment.json", JSON.stringify(deployment, null, 2));

console.log("Network       http://127.0.0.1:8545");
console.log("DemoToken    ", tokenAddress);
console.log("VestingVault ", vaultAddress);
console.log("Funded vault ", (await token.balanceOf(vaultAddress)).toString(), "DEMO");
