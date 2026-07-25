const { google } = require("googleapis");

// Read a required environment variable (user name and secrets) from Github Action.
// If it is missing, fail the GitHub Action.
function requiredEnv(name) {
    const value = process.env[name];

    if (!value) {
        console.error(`Missing required environment variable: ${name}`);
        process.exit(1);
    }

    return value;
}

// Normalize GitHub usernames so comparisons are consistent.
function normalize(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^@/, "");
}
// Checking extra contributors
//
// Helper functions for checking extra contributors listed in the PR.
// Some labels include special characters like parentheses.
// This makes the label safe to use inside a regular expression.
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The template says to leave the field blank if there are no extra contributors.
// This also handles common answers like "N/A" or "none".
function isIgnoredContributorValue(value) {
    const ignoredValues = new Set([
        "n/a", "none", "no additional contributors",
    ]);
    return ignoredValues.has(normalize(value));
}

// Make sure the entered value has a GitHub username format not full name or email address.
function isValidGitHubUsername(username) {
    return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username);
}

// Read extra contributor usernames from the PR description.
// Expected format:
//
// **Additional contributor GitHub username(s):**
//
// username1, username2
//
// (Leave blank if none. If others contributed, list GitHub username(s), separated by commas.)
//
// The instruction line in parentheses is ignored, so contributors do not
// have to delete it before submitting the PR.
function parseAdditionalContributors(prBody) {
    const label = "Additional contributor GitHub username(s):";
    const escapedLabel = escapeRegex(label);

    const regex = new RegExp(
        `\\*\\*${escapedLabel}\\*\\*\\s*([\\s\\S]*?)(?=\\r?\\n##|$)`,
        "i"
    );

    const match = prBody.match(regex);

    if (!match) {
        return [];
    }

    // If someone accidentally repeats the field label, Additional contributor GitHub username(s):
    // remove it before checking.
    const repeatedLabelRegex = new RegExp(
        `^\\*{0,2}${escapedLabel}\\*{0,2}\\s*`,
        "i"
    );

    const rawValue = match[1]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

        // Ignore the template instruction line.
        //(Leave blank if none. If others contributed, list GitHub username(s), separated by commas.)
        .filter((line) => !line.startsWith("("))
        // Ignore example lines if examples are added later.
        .filter((line) => !/^example:/i.test(line))
        // Remove repeated label text if it was accidentally copied into the field.
        .map((line) => line.replace(repeatedLabelRegex, "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();

    if (!rawValue || isIgnoredContributorValue(rawValue)) {
        return [];
    }

    // Allow usernames to be separated by commas, spaces, or new lines.
    const usernames = rawValue
        .split(/[,\s]+/)
        .map((username) => normalize(username))
        .filter(Boolean)
        .filter((username) => !isIgnoredContributorValue(username));

    const invalidUsernames = usernames.filter(
        (username) => !isValidGitHubUsername(username)
    );

    if (invalidUsernames.length > 0) {
        console.error("Invalid additional contributor GitHub username(s):");

        for (const username of invalidUsernames) {
            console.error(`- ${username}`);
        }

        console.error("Use GitHub usernames only, separated by commas.");
        process.exit(1);
    }

    return usernames;
}
/// End of checking extra contributors



async function main() {
    // GitHub username.
    const githubLogin = normalize(requiredEnv("GITHUB_LOGIN"));

    // Pull request body, used to read additional contributor usernames.
    const prBody = process.env.PR_BODY || "";

    // Google Sheet info.
    const spreadsheetId = requiredEnv("CLA_SHEET_ID");
    const range = process.env.CLA_RANGE || "Form Responses 1!A:Z";

    // Google Service account credentials.
    const credentials = JSON.parse(requiredEnv("GOOGLE_SERVICE_ACCOUNT_JSON"));

    // Fix private key formatting if GitHub stores newline characters as "\n".
    if (credentials.private_key) {
        credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    }

    // Authenticate with Google Sheets.
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // Read the CLA response Sheet.
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });

    const rows = response.data.values || [];

    if (rows.length === 0) {
        console.error("CLA sheet is empty or could not be read.");
        process.exit(1);
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);

    // Find the column that stores contributor GitHub usernames. Column named is Github Username
    // If the CLA response Sheet uses a different column name, update ("github") and ("username") to match the actual header.

    const githubColumnIndex = headers.findIndex((header) => {
        const normalizedHeader = normalize(header);

        return (
            normalizedHeader.includes("github") &&
            normalizedHeader.includes("username")
        );
    });

    if (githubColumnIndex === -1) {
        console.error("Could not find a GitHub username column in the CLA sheet.");
        console.error("Add a required Google Form field named: GitHub username.");
        process.exit(1);
    }
    // Build a set of all GitHub usernames found in the CLA records.
    const signedUsers = new Set();

    for (const row of dataRows) {
        const username = normalize(row[githubColumnIndex]);

        if (username) {
            signedUsers.add(username);
        }
    }

    // Build a set of everyone who needs to be checked.
    // This includes the PR author and any additional contributors listed in the PR body.
    const contributorsToCheck = new Set();

    contributorsToCheck.add(githubLogin);

    const additionalContributors = parseAdditionalContributors(prBody);

    for (const contributor of additionalContributors) {
        contributorsToCheck.add(contributor);
    }

    // Find any required contributor who is not listed in the CLA records.
    const missingUsers = [...contributorsToCheck].filter(
        (username) => !signedUsers.has(username)
    );

    if (missingUsers.length > 0) {
        const message =
            "The following GitHub username(s) were not found in the CLA response records: " +
            `${missingUsers.join(", ")}. ` +
            "Each listed contributor must complete the OED Contributor License Agreement and make sure the GitHub username in the CLA form matches their GitHub account.";

        console.error("Signed CLA verification failed.");
        console.error(message);
        console.error(`::error title=Signed CLA Verification Failed::${message}`);
        process.exit(1);
    }

    // If no missing usernames were found, the CLA verification passes.
    console.log("Signed CLA verification passed.");
    console.log(`Verified contributor username(s): ${[...contributorsToCheck].join(", ")}`
    );
}

main().catch((error) => {
    console.error("Unexpected error while checking CLA:");
    console.error(error);
    process.exit(1);
});
