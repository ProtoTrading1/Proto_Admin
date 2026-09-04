import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Boxes,
  ChevronDown,
  CircleCheck,
  Database,
  Globe2,
  Info,
  Loader2,
  PackageSearch,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
} from 'lucide-react';
import { fetchProductIntelligence } from '../lib/productIntelligence';
import { buildProductAnswer, extractProductCode } from '../lib/apolloConversation';
import { askApolloOperations, readSavedApolloAnswer, rememberApolloReference, savedApolloReference } from '../lib/apolloOperations';
import { isReadOnlyPreviewHost } from '../lib/previewWriteGuard';
import { APOLLO_SOURCE_CATALOG } from '../../lib/apollo-source-catalog.mjs';

const EXAMPLE_CODE = '8610100040N';
const CONNECTED_SOURCE_COUNT = APOLLO_SOURCE_CATALOG.filter((source) => source.status === 'connected').length;

function EvidenceRow({ label, value }) {
  return <div className="apollo-evidence-row"><dt>{label}</dt><dd>{value}</dd></div>;
}

function SourceBadge({ status, label }) {
  const available = status === 'available';
  return <span className={`apollo-source-badge${available ? ' apollo-source-badge--live' : ''}`}>{available ? 'Available' : label}</span>;
}

function FactRow({ icon: Icon, number, title, value, detail, source, checkedAt, tone = 'red' }) {
  return (
    <details className="apollo-fact-row">
      <summary>
        <span className={`apollo-fact-row__icon apollo-fact-row__icon--${tone}`}><Icon size={18} /></span>
        <span className="apollo-fact-row__label"><strong>{number}. {title}</strong><small>{detail}</small></span>
        <span className="apollo-fact-row__value">{value}</span>
        <span className="apollo-fact-row__meta"><small>Source</small><strong>{source}</strong></span>
        <span className="apollo-fact-row__meta"><small>Checked</small><strong>{checkedAt}</strong></span>
        <ChevronDown size={17} className="apollo-fact-row__chevron" />
      </summary>
      <div className="apollo-fact-row__details">This number is shown exactly as returned by the named read-only source.</div>
    </details>
  );
}

function WelcomeMessage({ onTryExample, onAskOperations, onAskCustomers, onAskHealth }) {
  return (
    <div className="apollo-welcome" data-testid="apollo-welcome">
      <span className="apollo-avatar apollo-avatar--assistant"><Bot size={19} /></span>
      <div className="apollo-message apollo-message--assistant">
        <div className="apollo-message__heading"><strong>Apollo</strong><span>Read-only business assistant</span></div>
        <h2>What would you like to know?</h2>
        <p>Ask what needs attention across Proto, what customers are looking at, how orders are moving, whether systems are healthy, or check an exact product code.</p>
        <div className="apollo-welcome__actions">
          <button type="button" onClick={onAskOperations}><Sparkles size={16} /> What needs my attention?</button>
          <button type="button" onClick={onAskCustomers}><Globe2 size={16} /> What are customers viewing?</button>
          <button type="button" onClick={onAskHealth}><Database size={16} /> Are systems healthy?</button>
          <button type="button" onClick={onTryExample}><PackageSearch size={16} /> Check product {EXAMPLE_CODE}</button>
        </div>
      </div>
    </div>
  );
}

const severityLabel = { high: 'Priority', medium: 'Review', low: 'Note' };

function OperationsAnswer({ report, onSelectSection, preview }) {
  return (
    <div className="apollo-message-row" data-testid="apollo-operations-answer">
      <span className="apollo-avatar apollo-avatar--assistant"><Bot size={19} /></span>
      <article className="apollo-message apollo-message--assistant">
        <div className="apollo-message__heading"><strong>Apollo</strong><span>{preview ? 'Preview environment — not a live Proto check' : (report.periodLabel || (report.periodDays ? `${report.periodDays}-day view` : 'Live operational check'))}</span></div>
        <h2>{report.title}</h2>
        <p>{report.summary}</p>
        {!!report.findings?.length && <div className="apollo-operations-findings">{report.findings.map((item) => (
          <section key={`${item.severity}-${item.title}`} className={`apollo-operations-finding apollo-operations-finding--${item.severity}`}>
            <div><span>{severityLabel[item.severity] || 'Review'}</span><strong>{item.title}</strong></div>
            <p>{item.explanation}</p>
            {item.recommendedAction && <p><strong>Recommended:</strong> {item.recommendedAction}</p>}
            {!!item.evidence?.length && <ul>{item.evidence.map((line) => <li key={line}>{line}</li>)}</ul>}
          </section>
        ))}</div>}
        {!report.findings?.length && !report.limitations?.length && <div className="apollo-answer-note"><CircleCheck size={17} /><span>{preview ? 'Preview results cannot establish whether live Proto needs attention.' : 'No source-backed concern was found for this question.'}</span></div>}
        {!!report.limitations?.length && <div className="apollo-operations-limitations"><strong>What Apollo could not verify</strong><ul>{report.limitations.map((line) => <li key={line}>{line}</li>)}</ul></div>}
        {report.section && <button type="button" className="apollo-open-source" onClick={() => onSelectSection(report.section)}><Database size={15} /> Open the full source screen</button>}
      </article>
    </div>
  );
}

function ProductAnswer({ answer }) {
  const displayedPrice = answer.website.price !== 'Not available' ? answer.website.price : answer.positill.price;
  const displayedStock = answer.positill.availableStock !== 'Not available' ? answer.positill.availableStock : answer.website.availableStock;
  return (
    <div className="apollo-message-row" data-testid="apollo-product-answer">
      <span className="apollo-avatar apollo-avatar--assistant"><Bot size={19} /></span>
      <article className="apollo-message apollo-message--assistant">
        <div className="apollo-message__heading"><strong>Apollo</strong><span>{answer.checkedAt}</span></div>
        <p>Here’s what I found about code <strong>{answer.code}</strong>.</p>
        <h2>Executive summary</h2>
        <p>{answer.summary}</p>
        <div className="apollo-facts">
          <FactRow icon={Tag} number="1" title="Product & price" value={displayedPrice} detail={answer.title} source={answer.website.price !== 'Not available' ? answer.website.source : answer.positill.source} checkedAt={answer.checkedAt} />
          <FactRow icon={Boxes} number="2" title="Available stock" value={displayedStock} detail={answer.stockDifference === 0 ? 'Sources agree' : 'Compare both records'} source={answer.positill.availableStock !== 'Not available' ? answer.positill.source : answer.website.source} checkedAt={answer.checkedAt} tone="green" />
          <FactRow icon={Globe2} number="3" title="Website listing" value={answer.website.status === 'available' ? 'Listed' : 'Not found'} detail={answer.website.category} source={answer.website.source} checkedAt={answer.checkedAt} tone="blue" />
          <FactRow icon={Database} number="4" title="Source confidence" value={answer.confidence} detail={answer.degraded ? 'Some evidence is incomplete' : 'Authoritative records returned'} source="Apollo checks" checkedAt={answer.checkedAt} tone="orange" />
        </div>
        <div className={`apollo-answer-note${answer.degraded ? ' apollo-answer-note--warning' : ''}`}>
          {answer.degraded ? <AlertTriangle size={17} /> : <Info size={17} />}
          <span>All data is read-only. Differences can happen when systems update at different times.</span>
        </div>
      </article>
    </div>
  );
}

function EvidenceCanvas({ answer, operations, preview }) {
  if (operations) {
    return (
      <aside className="apollo-evidence" aria-label="Apollo evidence canvas">
        <div className="apollo-evidence__head"><div><strong>Evidence canvas</strong><p>The approved read-only sources behind Apollo's operational answer.</p></div><ShieldCheck size={18} /></div>
        <section className="apollo-evidence-section">
          <div className="apollo-evidence-title"><strong>Sources checked</strong><SourceBadge status={preview ? 'preview' : 'available'} label={preview ? 'Preview environment' : 'Available'} /></div>
          <dl>{(operations.sources || []).map((source) => <EvidenceRow key={source} label="Read-only source" value={source} />)}</dl>
        </section>
        <section className="apollo-evidence-section apollo-evidence-section--confidence">
          <div className="apollo-evidence-title"><strong>Privacy boundary</strong><span className="apollo-confidence"><CircleCheck size={15} />Protected</span></div>
          <p>{operations.identityHandledLocally
            ? 'This answer was calculated inside authenticated Admin. The company/customer name was not sent to the Codex CLI worker.'
            : 'Codex receives aggregate figures and opaque product references only. Customer names and contact details are excluded.'}</p>
          <small>{preview ? 'Preview evidence only — not live operational status' : (operations.periodLabel ? `${operations.periodLabel} reporting window` : (operations.periodDays ? `${operations.periodDays}-day reporting window` : 'Current operational status'))}</small>
        </section>
        <div className="apollo-evidence__footer"><ShieldCheck size={15} /> Read-only. Business records cannot be changed.</div>
      </aside>
    );
  }
  if (!answer) {
    return (
      <aside className="apollo-evidence" aria-label="Apollo evidence canvas">
        <div className="apollo-evidence__head"><div><strong>Evidence canvas</strong><p>Exact records will appear here beside Apollo’s answer.</p></div><ShieldCheck size={18} /></div>
        <div className="apollo-evidence-empty"><Database size={24} /><strong>No evidence loaded</strong><span>Ask Apollo a question to load the approved operational evidence.</span></div>
        <div className="apollo-evidence__footer"><ShieldCheck size={15} /> Read-only. Nothing can be changed.</div>
      </aside>
    );
  }
  return (
    <aside className="apollo-evidence" aria-label="Apollo evidence canvas">
      <div className="apollo-evidence__head"><div><strong>Evidence canvas</strong><p>Exact records behind every number.</p></div><Info size={17} /></div>
      <section className="apollo-evidence-section">
        <div className="apollo-evidence-title"><strong>Positill record</strong><SourceBadge status={answer.positill.status} label="Unavailable" /></div>
        <dl>
          <EvidenceRow label="Product code" value={answer.positill.code} />
          <EvidenceRow label="Description" value={answer.positill.title} />
          <EvidenceRow label="Recorded price" value={answer.positill.price} />
          <EvidenceRow label="On hand" value={answer.positill.stockOnHand} />
          <EvidenceRow label="Booked" value={answer.positill.booked} />
          <EvidenceRow label="Available" value={answer.positill.availableStock} />
          <EvidenceRow label="Department" value={answer.positill.department} />
        </dl>
      </section>
      <section className="apollo-evidence-section">
        <div className="apollo-evidence-title"><strong>Website record</strong><SourceBadge status={answer.website.status} label="Unavailable" /></div>
        <dl>
          <EvidenceRow label="Product code" value={answer.website.code} />
          <EvidenceRow label="Product title" value={answer.website.title} />
          <EvidenceRow label="Price (incl. VAT)" value={answer.website.price} />
          <EvidenceRow label="On hand" value={answer.website.stockOnHand} />
          <EvidenceRow label="Available" value={answer.website.availableStock} />
          <EvidenceRow label="Category" value={answer.website.category} />
        </dl>
      </section>
      <section className="apollo-evidence-section apollo-evidence-section--confidence">
        <div className="apollo-evidence-title"><strong>Confidence</strong><span className={answer.confidence !== 'High' ? 'apollo-confidence--warning' : 'apollo-confidence'}>{answer.confidence !== 'High' ? <AlertTriangle size={15} /> : <CircleCheck size={15} />}{answer.confidence}</span></div>
        <p>{answer.degraded ? 'At least one source is incomplete, unavailable or using an approved cache.' : answer.stockDifference !== 0 ? 'The sources disagree. Review both records before relying on the stock figure.' : 'The current response came from the available authoritative read-only sources.'}</p>
        <small>Response generated {answer.checkedAt}</small>
      </section>
      <div className="apollo-evidence__footer"><ShieldCheck size={15} /> Read-only. Nothing can be changed.</div>
    </aside>
  );
}

export default function HermesPanel({ onSelectSection }) {
  const preview = isReadOnlyPreviewHost(typeof window === 'undefined' ? '' : window.location.hostname);
  const [question, setQuestion] = useState('');
  const [submittedQuestion, setSubmittedQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [operations, setOperations] = useState(null);
  const [mode, setMode] = useState('welcome');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null);
  const [pendingJob, setPendingJob] = useState(null);
  const [savedJobId, setSavedJobId] = useState(() => savedApolloReference(typeof window === 'undefined' ? '' : window.location.search));
  const [answerJobId, setAnswerJobId] = useState(null);
  const [conversation, setConversation] = useState([]);
  const requestRef = useRef(null);

  useEffect(() => () => requestRef.current?.abort(), []);
  const exampleQuestion = useMemo(() => `Tell me everything important about code ${EXAMPLE_CODE}.`, []);

  const askApollo = async (event, suppliedQuestion) => {
    event?.preventDefault();
    if (requestRef.current) return;
    const nextQuestion = String(suppliedQuestion ?? question).trim();
    if (!nextQuestion) { setError('Type a question for Apollo.'); return; }

    const code = extractProductCode(nextQuestion);
    setQuestion(nextQuestion);
    setSubmittedQuestion(nextQuestion);
    setError('');
    setAnswer(null);
    setOperations(null);
    setAnswerJobId(null);
    setProgress(null);
    const resumeJobId = pendingJob?.question === nextQuestion ? pendingJob.id : undefined;
    if (!resumeJobId) setPendingJob(null);

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setMode('loading');
    try {
      if (code) {
        const product = await fetchProductIntelligence(code, { signal: controller.signal });
        if (controller.signal.aborted || requestRef.current !== controller) return;
        if (!product) { setMode('not-found'); return; }
        const productAnswer = buildProductAnswer(product, code);
        setAnswer(productAnswer);
        setConversation((turns) => [...turns,
          { role: 'user', content: nextQuestion, sourcePlan: ['product_intelligence'] },
          { role: 'assistant', content: productAnswer.summary, sourcePlan: ['product_intelligence'] },
        ].slice(-4));
        setMode('answer');
      } else {
        const report = await askApolloOperations(nextQuestion, {
          signal: controller.signal, resumeJobId, context: conversation,
          onProgress: (nextProgress) => {
            if (controller.signal.aborted || requestRef.current !== controller) return;
            setProgress(nextProgress);
            if (rememberApolloReference(nextProgress.jobId)) {
              setSavedJobId(nextProgress.jobId);
              setAnswerJobId(nextProgress.jobId);
            }
            if (['completed', 'failed'].includes(nextProgress.status)) setPendingJob(null);
            else if (nextProgress.jobId) setPendingJob({ id: nextProgress.jobId, question: nextQuestion });
          },
        });
        if (controller.signal.aborted || requestRef.current !== controller) return;
        setPendingJob(null);
        setOperations(report);
        if (report.type !== 'clarification') {
          setConversation((turns) => [...turns,
            { role: 'user', content: nextQuestion, sourcePlan: report.sourcePlan || [] },
            { role: 'assistant', content: report.summary, sourcePlan: report.sourcePlan || [] },
          ].slice(-4));
        }
        setMode('operations');
      }
    } catch (lookupError) {
      if (lookupError.name !== 'AbortError' && requestRef.current === controller && !controller.signal.aborted) {
        setError(lookupError.message || 'Apollo could not complete that lookup.');
        setMode('error');
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  const recoverSavedAnswer = async () => {
    if (!savedJobId || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setSubmittedQuestion('Open my saved Apollo answer');
    setAnswerJobId(null);
    setAnswer(null);
    setOperations(null);
    setError('');
    setProgress(null);
    setMode('loading');
    try {
      const report = await readSavedApolloAnswer(savedJobId, {
        signal: controller.signal,
        onProgress: (nextProgress) => {
          if (!controller.signal.aborted && requestRef.current === controller) setProgress(nextProgress);
        },
      });
      if (controller.signal.aborted || requestRef.current !== controller) return;
      setPendingJob(null);
      setAnswerJobId(savedJobId);
      setOperations(report);
      setMode('operations');
    } catch (lookupError) {
      if (lookupError.name !== 'AbortError' && !controller.signal.aborted && requestRef.current === controller) {
        setError(lookupError.message || 'The saved answer could not be loaded. No new analysis was requested.');
        setMode('error');
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  const stopWaiting = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    setMode('stopped');
  };

  const handleQuestionKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    // Prevent the single-line input's implicit form submit for Shift+Enter and
    // IME confirmation, as well as the Enter handled explicitly below.
    event.preventDefault();
    if (!event.shiftKey && !event.nativeEvent?.isComposing && event.keyCode !== 229) void askApollo(event);
  };

  return (
    <section className="adm-panel apollo-workspace" aria-labelledby="apollo-title">
      <header className="apollo-workspace__header">
        <div>
          <div className="intelligence-eyebrow"><Bot size={15} /> Proto Intelligence</div>
          <h2 id="apollo-title" className="adm-section-title">Apollo</h2>
          <p className="adm-section-note">Your read-only eyes and ears across Proto Trading, with the evidence shown beside every answer.</p>
        </div>
        <span className="intelligence-readonly"><ShieldCheck size={15} /> Read-only</span>
      </header>
      <div className="apollo-coverage" role="status">
        <span><CircleCheck size={15} /> {CONNECTED_SOURCE_COUNT} approved sources connected</span>
        <button type="button" onClick={() => askApollo(null, 'What can Apollo access?')}>View Apollo coverage</button>
      </div>
      {preview && <p className="apollo-answer-note apollo-answer-note--warning" role="note"><AlertTriangle size={17} /><span>Preview mode. These results describe this preview, not the live Proto website. Missing records or an offline bridge here do not prove a production problem.</span></p>}
      <div className="apollo-layout">
        <div className="apollo-conversation" aria-live="polite">
          {submittedQuestion && <div className="apollo-message-row apollo-message-row--user"><span className="apollo-avatar apollo-avatar--user">G</span><div className="apollo-message apollo-message--user"><span>{submittedQuestion}</span></div></div>}
          {mode === 'welcome' && <WelcomeMessage onTryExample={() => askApollo(null, exampleQuestion)} onAskOperations={() => askApollo(null, 'What needs my attention across Proto today?')} onAskCustomers={() => askApollo(null, 'What products and categories are customers viewing, and for how long?')} onAskHealth={() => askApollo(null, 'Are all Proto systems healthy?')} />}
          {mode === 'loading' && <div className="apollo-loading" role="status"><Loader2 size={24} className="spin" /><div><strong>{progress?.status === 'queued' ? 'Waiting for the analysis worker' : progress ? 'Preparing your answer' : 'Checking approved sources'}</strong><span>{progress?.status === 'queued' ? (progress.delayed ? 'Your request is still queued. The worker has not picked it up yet. You can stop waiting and check this same request again.' : 'Your question is in the queue. No answer has been generated yet.') : extractProductCode(submittedQuestion) ? 'Comparing the exact Positill code with the website catalogue.' : 'Gathering the approved evidence for your question.'}</span><button type="button" className="adm-btn-ghost" onClick={stopWaiting}>Stop waiting</button></div></div>}
          {mode === 'stopped' && <div className="apollo-state-card" role="status"><Info size={24} /><div><strong>Waiting stopped</strong><span>Your question is kept below. A queued analysis may still finish; stopping here does not cancel the server job.</span></div></div>}
          {mode === 'answer' && answer && <ProductAnswer answer={answer} />}
          {mode === 'operations' && operations && <OperationsAnswer report={operations} onSelectSection={onSelectSection} preview={preview} />}
          {mode === 'not-found' && <div className="apollo-state-card"><PackageSearch size={24} /><div><strong>No exact product found</strong><span>Check the code and ask again. Apollo has not changed any information.</span></div></div>}
          {mode === 'error' && <div className="apollo-state-card apollo-state-card--error"><AlertTriangle size={24} /><div><strong>Could not load your answer</strong><span>{error}</span></div></div>}
          {pendingJob && mode !== 'loading' && <button type="button" className="adm-btn-ghost" onClick={() => askApollo(null, pendingJob.question)}>Check this request again</button>}
          {savedJobId && !pendingJob && mode !== 'loading' && mode !== 'operations' && <div className="apollo-state-card"><Info size={24} /><div><strong>Your previous analysis</strong><span>Check its status or open the completed answer. This does not request another analysis.</span><button type="button" className="adm-btn-ghost" onClick={recoverSavedAnswer}>View saved answer</button></div></div>}
          {answerJobId && mode === 'operations' && <a className="apollo-open-source" href={`?section=hermes&apolloJob=${encodeURIComponent(answerJobId)}`}>Saved answer link — bookmark to reopen</a>}
          <form className="apollo-composer" onSubmit={askApollo}>
            <label htmlFor="apollo-question">Ask Apollo</label>
            <div><input id="apollo-question" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={handleQuestionKeyDown} placeholder="Ask what is happening across Proto…" autoComplete="off" disabled={mode === 'loading'} /><button type="submit" aria-label="Send question" disabled={mode === 'loading'}>{mode === 'loading' ? <Loader2 size={19} className="spin" /> : <Send size={19} />}</button></div>
            {error && mode !== 'error' && <p className="apollo-composer__error" role="alert">{error}</p>}
          </form>
          <div className="apollo-suggestions" aria-label="Suggested questions"><span>Try asking</span><button type="button" disabled={mode === 'loading'} onClick={() => askApollo(null, 'What needs my attention across Proto today?')}><Sparkles size={15} /> Morning brief</button><button type="button" disabled={mode === 'loading'} onClick={() => askApollo(null, 'What are customers searching for but not finding?')}><Globe2 size={15} /> Search gaps</button><button type="button" disabled={mode === 'loading'} onClick={() => askApollo(null, 'Are featured products, specials and the homepage banner configured?')}><Globe2 size={15} /> Website content</button><button type="button" disabled={mode === 'loading'} onClick={() => askApollo(null, exampleQuestion)}><PackageSearch size={15} /> Product {EXAMPLE_CODE}</button></div>
        </div>
        <EvidenceCanvas answer={answer} operations={operations} preview={preview} />
      </div>
      <footer className="apollo-workspace__footer"><span>Times shown in South Africa Standard Time (UTC+2).</span><span><i className="apollo-status-dot" /> Data is requested only when you ask.</span></footer>
    </section>
  );
}
