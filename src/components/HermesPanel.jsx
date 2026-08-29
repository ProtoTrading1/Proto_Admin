import { Bot, ClipboardList, Search, ShieldCheck } from 'lucide-react';

const FOUNDATIONS = [
  {
    id: 'product-intelligence',
    title: 'Product Intelligence',
    description: 'Open one Positill CODE and review its joined operational picture.',
    icon: Search,
    status: 'Frontend ready',
  },
  {
    id: 'buying',
    title: 'Buying',
    description: 'The future home of supplier intake, Apollo evidence and Atlas recommendations.',
    icon: ClipboardList,
    status: 'Shell ready',
  },
];

export default function HermesPanel({ onSelectSection }) {
  return (
    <section className="adm-panel intelligence-panel" aria-labelledby="hermes-title">
      <div className="adm-section-head intelligence-panel__head">
        <div>
          <div className="intelligence-eyebrow"><Bot size={15} /> Proto Intelligence</div>
          <h2 id="hermes-title" className="adm-section-title">Apollo</h2>
          <p className="adm-section-note">
            A read-only foundation for joined Positill, website and buying intelligence inside the existing admin login.
          </p>
        </div>
        <span className="intelligence-readonly"><ShieldCheck size={15} /> Read-only foundation</span>
      </div>

      <div className="intelligence-callout" role="status">
        <strong>The first authenticated intelligence lookup is connected.</strong>
        <span>Product Intelligence can now join available Positill and website data. Sales, incoming stock and saved buying decisions remain staged for later phases.</span>
      </div>

      <div className="intelligence-launch-grid">
        {FOUNDATIONS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="intelligence-launch-card"
              onClick={() => onSelectSection(item.id)}
            >
              <span className="intelligence-launch-card__icon"><Icon size={20} /></span>
              <span className="intelligence-launch-card__copy">
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
              <span className="intelligence-status-tag">{item.status}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
