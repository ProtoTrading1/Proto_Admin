import { ClipboardCheck, FileUp, SearchCheck, ShieldCheck, Sparkles } from 'lucide-react';

const STAGES = [
  {
    title: '1. Supplier intake',
    description: 'Upload supplier sheets, PDFs and images into one controlled order workspace.',
    icon: FileUp,
  },
  {
    title: '2. Apollo evidence',
    description: 'Match Positill CODEs and retrieve approved stock, sales and supplier evidence.',
    icon: SearchCheck,
  },
  {
    title: '3. Atlas review',
    description: 'Calculate recommendations using stock, incoming quantities, velocity and seasonality.',
    icon: Sparkles,
  },
  {
    title: '4. Gee approval',
    description: 'Review exact final quantities before an export or any later controlled action.',
    icon: ClipboardCheck,
  },
];

export default function BuyingPanel({ onOpenProductIntelligence }) {
  return (
    <section className="adm-panel intelligence-panel" aria-labelledby="buying-title">
      <div className="adm-section-head intelligence-panel__head">
        <div>
          <div className="intelligence-eyebrow"><Sparkles size={15} /> Hermes</div>
          <h2 id="buying-title" className="adm-section-title">Buying</h2>
          <p className="adm-section-note">The new server-backed home for supplier-order review and buying decisions.</p>
        </div>
        <span className="intelligence-readonly"><ShieldCheck size={15} /> Shell only · no imports</span>
      </div>

      <div className="buying-foundation-banner">
        <div>
          <strong>The Buying workspace foundation is ready.</strong>
          <span>The old standalone app has not been copied in. Its workflows will move here only after storage, permissions and API contracts are ready.</span>
        </div>
        <button type="button" className="adm-btn-ghost" onClick={onOpenProductIntelligence}>Open Product Intelligence</button>
      </div>

      <div className="buying-stage-grid">
        {STAGES.map((stage) => {
          const Icon = stage.icon;
          return (
            <article key={stage.title} className="buying-stage-card">
              <Icon size={20} />
              <h3>{stage.title}</h3>
              <p>{stage.description}</p>
              <span>Planned</span>
            </article>
          );
        })}
      </div>

      <div className="intelligence-empty buying-empty" role="status">
        <FileUp size={32} />
        <strong>No supplier order loaded</strong>
        <span>File intake and saved buying orders will be connected in a later, separately tested phase.</span>
      </div>
    </section>
  );
}

