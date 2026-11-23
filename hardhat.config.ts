import { createRequire } from "node:module";
import { defineConfig } from "hardhat/config";

const require = createRequire(import.meta.url);

export default defineConfig({
    solidity: {
        version: "0.8.24",
        path: require.resolve("solc/soljson.js"),
    },
    paths: { sources: "./src", tests: { solidity: "./hardhat-test" }, cache: "./hardhat-cache" },
    networks: {
        localhost: { type: "http", url: "http://127.0.0.1:8545" },
    },
});
