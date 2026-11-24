# Token Vesting Vault

An ERC-20 vesting vault for teams that distribute tokens to employees, investors,
and advisors on individual schedules.
![Uploading image.png…]()

## Vesting example

This example uses a 12-month cliff within a 48-month total duration.
The contract stores time in seconds.

| Time since start | Vested share |
| --- | ---: |
| Before month 12 | 0% |
| At month 12 | 25% |
| At month 24 | 50% |
| At month 36 | 75% |
| At month 48 and later | 100% |

## Run tests

Clone the repository with its submodules and run Forge from the project directory.

```bash
git clone --recurse-submodules https://github.com/Solnyshkaa/token-vesting-vault.git
cd token-vesting-vault
forge test
forge coverage
```

Coverage for `src/VestingVault.sol`: 100.00% line coverage and 67.57% branch coverage.

## Security model

- The owner can allocate funded tokens, revoke schedules marked as revocable,
  and withdraw the balance in excess of outstanding allocations.
- Anyone can trigger payment. The tokens always go to the schedule beneficiary.
- The current beneficiary can transfer the schedule to another address.
  Prior payouts remain recorded.
- A malicious owner or an attacker with the owner key can revoke the unvested
  portion of revocable schedules and withdraw unallocated funds. Already
  vested funds stay payable, and irrevocable schedules cannot be revoked.
- The vault checks available funding before creating a schedule. Token payouts
  update accounting before transfers, and token-moving entry points use a
  reentrancy guard. Vesting uses full-precision multiplication and division.

## Limitations

- The vault is designed for a standard ERC-20 token with predictable balances
  and exact transfers. Fee-on-transfer and rebasing tokens are unsupported.
- Schedule transfers search the sender's schedule list, so gas usage grows
  with the number of schedules held by that beneficiary.
- The vault depends on the token contract allowing transfers. A token pause
  or address blocklist can prevent payouts.
## Local Hardhat deployment and web interface

Requires Node.js 22.13 or newer. Run from the project root.

```powershell
npm.cmd ci
npm.cmd run chain
```

Leave the Hardhat terminal running. Open a second PowerShell terminal in the project root.

```powershell
npm.cmd run deploy:local
npm.cmd run dev
```

Open [Vesting Vault](http://127.0.0.1:5173/). The deployment script deploys
DemoToken and VestingVault, transfers 1500 DEMO to the vault, and writes
the deployment addresses and ABIs for the interface. The interface uses
the first Hardhat account and pre-fills the second account as beneficiary.

Create a default schedule, advance 30 minutes, then revoke and release.
The default schedule returns 500 DEMO to the owner and pays 500 DEMO to
the beneficiary. The "Available now" amount then reads zero.

Restarting the Hardhat node clears its state. Run the deployment again
and reload the page after a restart. If Anvil or another local node is
using port 8545, stop that process before starting Hardhat.

### Hardhat tests

Run the JavaScript integration tests with:

```powershell
npm.cmd test
```

Each test starts a fresh in-process Hardhat network. The 12 tests cover
deployment and funding, schedule creation, cliff and duration boundaries,
release and revocation, access controls, allocation limits, withdrawal of
unallocated tokens, and transfers of schedule ownership. The Foundry suite
is also available with `forge test`.
