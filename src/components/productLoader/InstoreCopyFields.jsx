import { useId } from 'react';
import { INSTORE_COPY_LIMITS, instoreCopyError } from '../../../lib/instore-copy.mjs';
import './InstoreCopyEditor.css';

export default function InstoreCopyFields({ copy, onChange, disabled, sku }) {
  const id = useId();
  const error = instoreCopyError(copy);
  return <fieldset className="ic-fields" disabled={disabled}>
    <legend>Website wording · {sku}</legend>
    <p id={`${id}-help`}>Saved in CAPITALS. Website wording only — Positill, code, price and stock stay unchanged.</p>
    <label>Website name<input aria-label={`Website name ${sku}`} aria-describedby={`${id}-help ${id}-validation`} value={copy.title}
      maxLength={INSTORE_COPY_LIMITS.title} onChange={(event) => onChange({ ...copy, title: event.target.value.toUpperCase() })} /></label>
    <label>Website description<textarea aria-label={`Website description ${sku}`} aria-describedby={`${id}-help ${id}-validation`} rows={3} value={copy.description}
      maxLength={INSTORE_COPY_LIMITS.description} onChange={(event) => onChange({ ...copy, description: event.target.value.toUpperCase() })} /></label>
    <small id={`${id}-validation`} className={error ? 'ic-error' : ''} role={error ? 'alert' : undefined}>{error || `${copy.title.length}/${INSTORE_COPY_LIMITS.title} name · ${copy.description.length}/${INSTORE_COPY_LIMITS.description} description`}</small>
  </fieldset>;
}
