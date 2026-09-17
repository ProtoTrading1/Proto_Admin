const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const upper = value => clean(value).toLocaleUpperCase('en-ZA');
const localCountry = value => /^(SOUTH AFRICA|REPUBLIC OF SOUTH AFRICA|ZA|ZAF|RSA)$/.test(upper(value));
const province = value => /^(EASTERN CAPE|FREE STATE|GAUTENG|KWAZULU[- ]NATAL|LIMPOPO|MPUMALANGA|NORTHERN CAPE|NORTH WEST|WESTERN CAPE)$/.test(value);
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function localAddressRows(address, customer, warnings) {
  const regionIndex = address.findLastIndex(province);
  // A bare four-digit first fragment could be a street/unit number, not a postcode.
  const postalIndexes = address.flatMap((part, index) => index > 0 && /^\d{4}$/.test(part) ? [index] : []);
  const postalIndex = postalIndexes.length === 1 ? postalIndexes[0] : -1;
  const profileCity = upper(customer.city);
  let cityIndex = address.findLastIndex((part, index) => index > 0 && part === profileCity);
  if (cityIndex < 0) {
    const anchors = [regionIndex, postalIndex].filter(index => index > 0);
    const candidate = anchors.length ? Math.min(...anchors) - 1 : -1;
    if (candidate > 0 && !/^\d+$/.test(address[candidate]) && !province(address[candidate])) cityIndex = candidate;
  }
  const city = cityIndex >= 0 ? address[cityIndex] : '';
  // Only supplement a missing province when the saved profile city matches an
  // explicit address fragment. Never derive a province from a town/postcode.
  const region = regionIndex >= 0 ? address[regionIndex]
    : city && city === profileCity && province(upper(customer.province)) ? upper(customer.province) : '';
  const postal = postalIndex >= 0 ? address[postalIndex] : '';
  const street = address.filter((part, index) => index !== regionIndex && index !== postalIndex
    && !(index > 0 && city && part === city)).join(', ');
  if (!city) warnings.push('Town/city is missing or cannot be identified safely. Its sticker row is left blank.');
  if (!region) warnings.push('Province is missing. Its sticker row is left blank; confirm it before printing.');
  if (!postal) warnings.push('Postal code is missing or ambiguous. Its sticker row is left blank.');
  if (!street) warnings.push('Street/building address is missing.');
  return [street, city, region, postal];
}

// Pure display/clipboard formatter. Never modifies the saved customer or order.
export function buildDeliveryLabel(customer = {}) {
  const warnings = [];
  const contact = upper(customer.contact_name || customer.name);
  const company = upper(customer.business_name) || contact;
  const phone = upper(customer.phone);
  const usable = value => clean(value) && !/^(to confirm|not provided|unknown|n\/a)$/i.test(clean(value));
  const delivery = usable(customer.delivery_address);
  const rawAddress = delivery ? customer.delivery_address : usable(customer.company_address) ? customer.company_address : '';
  if (!delivery && clean(rawAddress)) warnings.push('Using the company address because no delivery address is saved. Check it before printing.');
  const address = String(rawAddress ?? '').split(/\r?\n|,/).map(upper).filter(Boolean);
  const country = upper(customer.country);
  let foreignCountry = '';
  const hasLocalCountry = address.some(localCountry);
  if (hasLocalCountry) {
    for (let index = address.length - 1; index >= 0; index--) if (localCountry(address[index])) address.splice(index, 1);
  }
  else if (country && address.at(-1) === country) foreignCountry = address.pop();
  else if (country && !localCountry(country) && (/^\d{3,6}$/.test(address.at(-1) || '') || address.at(-1) === upper(customer.city) || province(address.at(-1) || ''))) foreignCountry = country;

  // International free-form addresses retain every fragment instead of forcing
  // them into South African province/postcode slots.
  const international = !hasLocalCountry && country && !localCountry(country);
  const addressRows = international ? [...address, ...(foreignCountry ? [foreignCountry] : [])]
    : localAddressRows(address, customer, warnings);
  if (international) warnings.push('International address: check the country and line positions against your sticker before printing.');
  if (!address.length) warnings.push('No full address is saved. Add it in Customer Management before copying a label.');
  if (!company) warnings.push('Customer or company name is missing.');
  if (!contact) warnings.push('Contact name is missing.');
  if (!phone) warnings.push('Phone number is missing.');
  const lines = [company, ...addressRows, contact, phone];
  // Plain text remains useful outside Excel. HTML marks every Excel cell as text,
  // preserving leading zeroes and preventing customer values being treated as formulas.
  const text = lines.join('\r\n');
  const html = `<html><body><table>${lines.map(line => `<tr><td style='mso-number-format:"\\@"'>${escapeHtml(line)}</td></tr>`).join('')}</table></body></html>`;
  return { lines, text, html, warnings, canCopy: address.length > 0 && Boolean(company), international: Boolean(international) };
}

export async function copyDeliveryLabel(label, browser = globalThis) {
  if (!label.canCopy) throw new Error('The label needs a customer and a saved address.');
  const clipboard = browser.navigator?.clipboard;
  if (clipboard?.write && browser.ClipboardItem) {
    await clipboard.write([new browser.ClipboardItem({
      'text/plain': new browser.Blob([label.text], { type: 'text/plain' }),
      'text/html': new browser.Blob([label.html], { type: 'text/html' }),
    })]);
    return 'excel';
  }
  if (!clipboard?.writeText) throw new Error('Automatic copying is not available.');
  await clipboard.writeText(label.text);
  return 'text';
}
