# Signed CLA Verification Notes

## Purpose

This prototype adds a GitHub Action that checks whether the pull request author has signed the Contributor License Agreement.

The goal is to reduce manual CLA checking and give contributors clearer feedback when their CLA status cannot be verified.

## How It Works

When a pull request is opened, edited, synchronized, or reopened, the workflow runs the `scripts/check-cla.js` script.

The script:

1. Reads the pull request author's GitHub username.
2. Connects to the Google Sheet that stores CLA form responses.
3. Looks for a column containing GitHub usernames.
4. Checks whether the pull request author's username appears in the Sheet.
5. Passes if the username is found.
6. Fails if the username is missing.

## Files Added

- `.github/workflows/check-cla.yml`
- `scripts/check-cla.js`

## Current Behavior

The current version checks only the pull request author.

It does not yet verify every possible contributor listed in the pull request description or commit history.

## Testing Notes

Planned tests:

Tests:
- Missing GitHub secret - failed
- missing Sheet ID - failed
- Missing GitHub secret - failed
- Google Sheet not shared - failed
- CLA box unchecked - unsigned - failed
- CLA box checked - unsigned - failed
- ClA box unchecked - signed - Pass
- CLA box unchecked - signed - Pass
## Limitations

- The username in the Sheet must match the pull request author's GitHub username.
- This prototype does not prevent a pull request from being opened.
- First-time outside contributor may require maintainer approval before the workflow runs.

- It only provides a status check that can be used to block merging.
- The current version checks the PR author only, not all contributors.
- Production use would require OED maintainer approval for secrets, Google Sheet access, and workflow security.

