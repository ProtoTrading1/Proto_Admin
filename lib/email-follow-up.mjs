/** Addresses eligible for a once-only no-open follow-up campaign. */
export function noRecordedOpenEmails(emails, { accepted, opened, bounced, unsubscribed, complained }) {
  return emails.filter((email) => accepted.has(email)
    && !opened.has(email)
    && !bounced.has(email)
    && !unsubscribed.has(email)
    && !complained.has(email));
}
