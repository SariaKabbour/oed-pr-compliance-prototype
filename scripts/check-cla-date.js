const { google } = require("googleapis");

// Expected Google Sheet headers.
const TIMESTAMP_COLUMN = "Timestamp";
const GITHUB_USERNAME_COLUMN =
  "GitHub Username (the Username shown in your profile/used for login)";
const MANUAL_DATE_COLUMN = "Enter today's date (not your birthday)";

// Read a required environment variable from GitHub Actions.
// If it is missing, fail the check with a clear message.
function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }

  return value;
}

// Normalize GitHub usernames so comparisons are consistent.
function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

// Normalize Sheet headers so small capitalization or spacing differences do not break matching.
function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Some labels include special characters like parentheses.
// This makes the label safe to use inside a regular expression.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The template says to leave the field blank if there are no extra contributors.
// This also handles common answers like "N/A" or "none".
function isIgnoredContributorValue(value) {
  const ignoredValues = new Set([
    "n/a",
    "na",
    "none",
    "no additional contributors",
  ]);

  return ignoredValues.has(normalizeUsername(value));
}

// Make sure the entered value looks like a GitHub username,
// not a full name or email address.
function isValidGitHubUsername(username) {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username);
}

// Read extra contributor usernames from the PR description.
// Expected format:
// **Additional contributor GitHub username(s):**
// username1, username2
// (Leave blank if none. If others contributed, list GitHub username(s), separated by commas.)
// The instruction line in parentheses is ignored.
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

  // If the label is accidentally typed again in the answer area,
  // remove the label and keep only the username.
  const repeatedLabelRegex = new RegExp(
    `^\\*{0,2}${escapedLabel}\\*{0,2}\\s*`,
    "i"
  );

  const rawValue = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // Ignore the template instruction line.
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

  const usernames = rawValue
    .split(/[,\s]+/)
    .map((username) => normalizeUsername(username))
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

// Find a Sheet column by its expected header.
function findColumnIndex(headers, expectedHeader) {
  const expected = normalizeHeader(expectedHeader);

  return headers.findIndex((header) => {
    return normalizeHeader(header) === expected;
  });
}

// Convert a calendar date to a day number.
// This lets us compare only the date, not the exact time.
function toUtcDayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

// Parse common date formats from Google Forms / Google Sheets.
//
// Supported examples:
// 7/23/2026
// 07/23/2026
// 7/23/2026 10:15:30
// 2026-07-23
//
// For slash dates, this assumes US format: month/day/year.
function parseDateToDayNumber(value) {
  const text = String(value || "").trim();

  if (!text) {
    return null;
  }

  // Match ISO format: YYYY-MM-DD
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    return toUtcDayNumber(year, month, day);
  }

  // Match US format: MM/DD/YYYY or MM-DD-YYYY.
  // This also works when the timestamp includes time after the date.
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);

  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    let year = Number(match[3]);

    if (year < 100) {
      year += 2000;
    }

    return toUtcDayNumber(year, month, day);
  }

  return null;
}

// The manually entered date is valid if it is the same day as the automatic
// Google Form timestamp, or one day before/after.
// The one-day buffer helps with time zone differences.
function datesAreCloseEnough(timestampValue, manualDateValue) {
  const timestampDay = parseDateToDayNumber(timestampValue);
  const manualDay = parseDateToDayNumber(manualDateValue);

  if (timestampDay === null || manualDay === null) {
    return false;
  }
  // buffer day
  return Math.abs(timestampDay - manualDay) <= 1;
}

async function main() {
  // GitHub username of the person who opened the pull request.
  const prAuthor = normalizeUsername(requiredEnv("GITHUB_LOGIN"));

  // Pull request body, used to read additional contributor usernames.
  const prBody = process.env.PR_BODY || "";

  // Google Sheet information passed from GitHub Actions secrets/environment.
  const spreadsheetId = requiredEnv("CLA_SHEET_ID");
  const range = process.env.CLA_RANGE || "Form Responses 1!A:Z";

  // Google service account credentials stored in GitHub Actions secrets.
  const credentials = JSON.parse(requiredEnv("GOOGLE_SERVICE_ACCOUNT_JSON"));

  // Fix private key formatting if GitHub stores newline characters as "\n".
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  }

  // Authenticate with Google Sheets using read-only access.
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

  // Find the required columns in the CLA response Sheet.
  const timestampColumnIndex = findColumnIndex(headers, TIMESTAMP_COLUMN);
  const githubColumnIndex = findColumnIndex(headers, GITHUB_USERNAME_COLUMN);
  const manualDateColumnIndex = findColumnIndex(headers, MANUAL_DATE_COLUMN);

  if (timestampColumnIndex === -1) {
    console.error(`Could not find required column: ${TIMESTAMP_COLUMN}`);
    process.exit(1);
  }

  if (githubColumnIndex === -1) {
    console.error(`Could not find required column: ${GITHUB_USERNAME_COLUMN}`);
    process.exit(1);
  }

  if (manualDateColumnIndex === -1) {
    console.error(`Could not find required column: ${MANUAL_DATE_COLUMN}`);
    process.exit(1);
  }

  // Build a set of everyone who needs a valid CLA date.
  // This includes the PR author and any additional contributors listed in the PR body.
  const contributorsToCheck = new Set();

  contributorsToCheck.add(prAuthor);

  const additionalContributors = parseAdditionalContributors(prBody);

  for (const contributor of additionalContributors) {
    contributorsToCheck.add(contributor);
  }

  const usersNotFound = [];
  const usersWithInvalidDates = [];

  for (const contributor of contributorsToCheck) {
    // Allow duplicate CLA entries.
    // A contributor passes if any one row for their GitHub username has a valid date.
    const rowsForContributor = dataRows.filter((row) => {
      return normalizeUsername(row[githubColumnIndex]) === contributor;
    });

    if (rowsForContributor.length === 0) {
      usersNotFound.push(contributor);
      continue;
    }

    const hasValidDate = rowsForContributor.some((row) => {
      const timestampValue = row[timestampColumnIndex];
      const manualDateValue = row[manualDateColumnIndex];

      return datesAreCloseEnough(timestampValue, manualDateValue);
    });

    if (!hasValidDate) {
      usersWithInvalidDates.push(contributor);
    }
  }
  //failure section
  if (usersNotFound.length > 0 || usersWithInvalidDates.length > 0) {
    console.error("CLA date verification failed.");

    if (usersNotFound.length > 0) {
      console.error("");
      console.error(
        "No CLA submission was found for the following GitHub username(s):"
      );

      for (const username of usersNotFound) {
        console.error(`- ${username}`);
      }

      console.error("");
      console.error(
        "Each listed contributor must submit the OED Contributor License Agreement using the exact GitHub username shown above."
      );
    }

    if (usersWithInvalidDates.length > 0) {
      console.error("");
      console.error(
        "A CLA submission was found for the following GitHub username(s), but the signing date was invalid:"
      );

      for (const username of usersWithInvalidDates) {
        console.error(`- ${username}`);
      }

      console.error("");
      console.error(
        "The date entered in the CLA form must match the date on which the form was submitted. A one-day difference is allowed for time zone differences."
      );

      console.error("");
      console.error("How to fix this:");
      console.error("1. Open the OED Contributor License Agreement link in the pull request description.");
      console.error("2. Submit the CLA form again. Duplicate submissions are allowed.");
      console.error("3. Enter the same GitHub username listed above.");
      console.error("4. In the date field, enter today's date—the date on which you are submitting the form.");
      console.error("5. Return to the pull request after submitting the form.");
      console.error("6. Edit the pull request description, uncheck the Contributor License Agreement checkbox, and save the description.");
      console.error("7. Edit the pull request description again, re-check the Contributor License Agreement checkbox, and save it.");
      console.error("8. Saving the updated pull request description will automatically run the CLA date verification check again.");
    }

    const errorDetails = [];

    if (usersNotFound.length > 0) {
      errorDetails.push(
        `No CLA submission was found for: ${usersNotFound.join(", ")}.`
      );
    }

    if (usersWithInvalidDates.length > 0) {
      errorDetails.push(
        `A CLA submission was found, but the signing date was invalid for: ${usersWithInvalidDates.join(", ")}. ` +
        "Submit the CLA form again using today's date, then edit and save the pull request description to rerun this check."
      );
    }

    console.error(
      `::error title=CLA Date Verification Failed::${errorDetails.join(" ")}`
    );

    process.exit(1);
  }
}