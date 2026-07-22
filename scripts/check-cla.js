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

async function main() {
    // GitHub username.
    const githubLogin = normalize(requiredEnv("GITHUB_LOGIN"));

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

    // Check whether the PR author's GitHub username appears in the CLA records.
    const signed = dataRows.some((row) => {
        return normalize(row[githubColumnIndex]) === githubLogin;
    });

    if (!signed) {
        const message =
            `GitHub user "${githubLogin}" was not found in the CLA response records. ` +
            "Please complete the OED Contributor License Agreement or confirm that the GitHub username in the CLA form matches this pull request author's GitHub username.";

        console.error("Signed CLA verification failed.");
        console.error(message);
        console.error(`::error title=Signed CLA Verification Failed::${message}`);
        process.exit(1);
    }

    console.log(`Signed CLA verification passed. GitHub user "${githubLogin}" was found.`);
}

main().catch((error) => {
    console.error("Unexpected error while checking CLA:");
    console.error(error);
    process.exit(1);
});
