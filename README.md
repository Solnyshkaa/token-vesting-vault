# Token Vesting Vault

An ERC-20 vesting vault for teams that distribute tokens to employees, investors,
and advisors on individual schedules.

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