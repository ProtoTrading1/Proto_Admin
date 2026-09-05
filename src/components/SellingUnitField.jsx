import { SELLING_UNIT_SUGGESTIONS } from '../../lib/selling-unit.mjs';

export default function SellingUnitField({
  value,
  onChange,
  label = 'Selling unit',
  id = 'selling-unit-options',
  className = 'adm-field-input',
}) {
  return (
    <label className="adm-field">
      <span className="adm-field-label">{label}</span>
      <input
        className={className}
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        list={id}
        maxLength={40}
        placeholder="EACH or PACK 10"
        autoCapitalize="characters"
      />
      <datalist id={id}>
        {SELLING_UNIT_SUGGESTIONS.map((option) => <option key={option} value={option} />)}
      </datalist>
      <small className="adm-muted">One basket quantity equals one selling unit.</small>
    </label>
  );
}
