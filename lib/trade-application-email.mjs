/** Trade application "approved" email — shared by API + smoke tests. */

export const TRADE_APPLICATION_EMAIL_SUBJECT = 'Your Proto Trading Online application has been approved';

export function tradeApplicationGreetingName({ name, businessName, email } = {}) {
  const contact = String(name || '').trim();
  if (contact) return contact;
  const business = String(businessName || '').trim();
  if (business) return business;
  const local = String(email || '').split('@')[0]?.trim();
  return local || 'there';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Full branded HTML for the "Application Approved" email. `greeting` is inserted
 * in place of {{name}} (already resolved to the contact/business/email-local).
 */
export function buildTradeApplicationHtml(greeting) {
  const name = escapeHtml(greeting);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Proto Trading Online Application Approved</title>
</head>

<body style="margin:0; padding:0; background-color:#050505; font-family:Arial, Helvetica, sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#050505" style="background-color:#050505; margin:0; padding:0;">
    <tr>
      <td align="center" style="padding:30px 10px; background-color:#050505;">

        <table width="680" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b0b0b" style="width:680px; background-color:#0b0b0b; border:1px solid #2a2a2a;">

          <!-- HEADER -->
          <tr>
            <td bgcolor="#000000" style="background-color:#000000; padding:35px 38px 30px 38px; border-bottom:1px solid #333333;">

              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="left" valign="middle" style="font-size:30px; font-weight:bold; letter-spacing:1px; color:#ffffff;">
                    <span style="color:#ffffff;">PROTO</span>
                    <span style="color:#e00000;"> TRADING</span>
                    <br>
                    <span style="display:block; color:#d99b3d; font-size:14px; font-weight:normal; letter-spacing:5px; margin-top:8px;">ONLINE</span>
                  </td>

                  <td align="right" valign="middle">
                    <table cellpadding="0" cellspacing="0" border="0" style="border:2px solid #d99b3d;">
                      <tr>
                        <td align="center" style="padding:14px 30px; color:#ffffff; font-size:18px; font-weight:bold;">
                          APPLICATION<br>
                          <span style="color:#d99b3d; font-size:28px;">APPROVED</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- HERO -->
          <tr>
            <td bgcolor="#080808" style="background-color:#080808; padding:38px 38px 10px 38px;">
              <h1 style="margin:0; padding:0; color:#ffffff; font-size:38px; line-height:46px; font-weight:bold; text-transform:uppercase;">
                Your Account Has Been <span style="color:#e00000;">Approved</span>
              </h1>

              <p style="margin:16px 0 0 0; padding:0; color:#d99b3d; font-size:20px; line-height:28px; font-weight:bold; text-transform:uppercase;">
                Welcome to Proto Trading Online
              </p>
            </td>
          </tr>

          <!-- MAIN TEXT -->
          <tr>
            <td bgcolor="#080808" style="background-color:#080808; padding:25px 38px 25px 38px;">
              <p style="margin:0; padding:0; color:#e6e6e6; font-size:16px; line-height:27px;">
                Dear ${name},
                <br><br>
                Thank you for completing your application for Proto Trading Online.
                <br><br>
                We&rsquo;re pleased to let you know that your application has been received and your account has been approved.
                <br><br>
                Our brand-new online website is almost ready, and we&rsquo;ll notify you as soon as it officially goes live.
              </p>
            </td>
          </tr>

          <!-- APPROVAL BOX -->
          <tr>
            <td bgcolor="#0b0b0b" style="background-color:#0b0b0b; padding:10px 38px 30px 38px;">

              <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#111111" style="background-color:#111111; border:1px solid #d99b3d;">
                <tr>
                  <td style="padding:28px;">
                    <h2 style="margin:0 0 14px 0; padding:0; color:#d99b3d; font-size:24px; line-height:30px;">
                      What happens next?
                    </h2>

                    <p style="margin:0 0 18px 0; color:#e6e6e6; font-size:16px; line-height:26px;">
                      Your account is now ready for launch. Once the website is live, you&rsquo;ll be able to access the new Proto Trading Online experience.
                    </p>

                    <p style="margin:0; color:#ffffff; font-size:15px; line-height:30px;">
                      &#10003; Your application has been received<br>
                      &#10003; Your account has been approved<br>
                      &#10003; Your details are ready for launch<br>
                      &#10003; We will notify you as soon as the website is live<br>
                      &#10003; You&rsquo;ll be able to start ordering online once the site opens
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- THANK YOU BOX -->
          <tr>
            <td bgcolor="#0b0b0b" style="background-color:#0b0b0b; padding:0 38px 30px 38px;">

              <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff7ee" style="background-color:#fff7ee; border:2px dashed #d99b3d;">
                <tr>
                  <td align="center" style="padding:32px 28px; color:#111111;">
                    <p style="margin:0; color:#d99b3d; font-size:30px; line-height:36px; font-family:Georgia, serif;">
                      Thank You
                    </p>

                    <p style="margin:14px 0 0 0; color:#111111; font-size:18px; line-height:28px;">
                      We appreciate your continued support and loyalty over the years.
                    </p>

                    <p style="margin:18px 0 0 0; color:#b30000; font-size:30px; line-height:38px; font-weight:bold;">
                      We can&rsquo;t wait to welcome you to our new online home.
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- STATUS SECTION -->
          <tr>
            <td align="center" bgcolor="#0b0b0b" style="background-color:#0b0b0b; padding:10px 38px 38px 38px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#e00000" style="background-color:#e00000;">
                    <span style="display:inline-block; padding:18px 46px; color:#ffffff; font-size:21px; line-height:24px; font-weight:bold; text-decoration:none; text-transform:uppercase; letter-spacing:1px;">
                      Account Approved
                    </span>
                  </td>
                </tr>
              </table>

              <p style="margin:14px 0 0 0; color:#d99b3d; font-size:14px; line-height:20px;">
                We&rsquo;ll be in touch as soon as Proto Trading Online launches.
              </p>
            </td>
          </tr>

          <!-- CLOSING -->
          <tr>
            <td bgcolor="#0b0b0b" style="background-color:#0b0b0b; padding:0 38px 38px 38px;">
              <p style="margin:0; color:#e6e6e6; font-size:16px; line-height:27px;">
                We&rsquo;re incredibly excited about what&rsquo;s coming and look forward to giving you a faster, easier and more personalised way to shop with Proto Trading.
                <br><br>
                Warm regards,
                <br><br>
                <strong style="color:#ffffff;">The Proto Trading Team</strong>
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" bgcolor="#000000" style="background-color:#000000; padding:25px 38px; border-top:1px solid #2a2a2a;">
              <p style="margin:0; color:#d99b3d; font-size:15px; line-height:22px; font-weight:bold;">
                Proto Trading Online
              </p>

              <p style="margin:10px 0 0 0; color:#777777; font-size:11px; line-height:18px;">
                You are receiving this email because you applied for access to Proto Trading Online.
                <br>
                We will notify you once the website is officially live.
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

/** Plain-text fallback for clients that don't render HTML. */
export function buildTradeApplicationText(greeting) {
  return [
    `Dear ${greeting},`,
    '',
    'Thank you for completing your application for Proto Trading Online.',
    '',
    'We’re pleased to let you know that your application has been received and your account has been approved.',
    '',
    'Our brand-new online website is almost ready, and we’ll notify you as soon as it officially goes live.',
    '',
    'What happens next?',
    '- Your application has been received',
    '- Your account has been approved',
    '- Your details are ready for launch',
    '- We will notify you as soon as the website is live',
    '- You’ll be able to start ordering online once the site opens',
    '',
    'Thank you for your continued support and loyalty over the years — we can’t wait to welcome you to our new online home.',
    '',
    'Warm regards,',
    'The Proto Trading Team',
  ].join('\n');
}

/**
 * Build the full trade-application "approved" email (subject + HTML + text).
 * The greeting is resolved from name / businessName / email-local.
 */
export function buildTradeApplicationEmail({ name, businessName, email } = {}) {
  const greeting = tradeApplicationGreetingName({ name, businessName, email });
  return {
    subject: TRADE_APPLICATION_EMAIL_SUBJECT,
    html: buildTradeApplicationHtml(greeting),
    text: buildTradeApplicationText(greeting),
    greeting,
  };
}
