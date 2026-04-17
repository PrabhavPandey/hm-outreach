import { useState } from "react";

// ── config ───────────────────────────────────────────────────────────────────
const APIFY = import.meta.env.VITE_APIFY_KEY;
const GEMINI = import.meta.env.VITE_GEMINI_KEY;

// ── url helpers ──────────────────────────────────────────────────────────────
function normCompanyUrl(s) {
  const t = s.trim().replace(/\/+$/, "");
  const m = t.match(/linkedin\.com\/company\/([^/?#]+)/);
  if (m) return `https://www.linkedin.com/company/${m[1]}/`;
  if (!t.includes("/")) return `https://www.linkedin.com/company/${t}/`;
  return t;
}
function normProfileUrl(s) {
  const t = s.trim().replace(/\/+$/, "");
  const m = t.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (m) return `https://www.linkedin.com/in/${m[1]}`;
  if (!t.includes("/")) return `https://www.linkedin.com/in/${t}`;
  return t;
}

// ── apify ────────────────────────────────────────────────────────────────────
async function scrapeActor(actorId, input) {
  // Use Apify's synchronous dataset streaming API. 
  // It waits for the run and returns the dataset directly in one go.
  const r = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY}&timeout=120`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    }
  );
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Apify sync scrape failed (${r.status}): ${errText}`);
  }
  return r.json();
}

// ── data processing ──────────────────────────────────────────────────────────
function slimEmployees(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  if (!arr.length) throw new Error("No employee data returned. Check if the company URL is correct.");
  const f = arr[0];
  const companyName = f?.companyName || f?.company ||
    f?.currentPosition?.[0]?.companyName || f?.experience?.[0]?.companyName || "Unknown";
  const profiles = arr.slice(0, 30).map(p => {
    const name = p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim() || "Unknown";
    const headline = p.headline || p.title || "";
    const edu = (p.education || p.educations || [])
      .map(e => e.schoolName || e.school || e.institutionName || "").filter(Boolean).slice(0, 2);
    const exp = (p.experience || p.experiences || p.positions || []).slice(0, 4)
      .map(e => `${e.title || e.position || ""} @ ${e.companyName || e.company || ""}`)
      .filter(e => e.length > 3);
    return { n: name, h: headline, edu, exp };
  });
  return { companyName, count: profiles.length, profiles };
}

function slimPerformer(raw, requestedUrl) {
  const p = Array.isArray(raw) ? raw[0] : raw;
  if (!p || Object.keys(p).length === 0) {
    const debug = JSON.stringify(raw).slice(0, 300);
    throw new Error(`Profile not found for "${requestedUrl}". (Apify returned: ${debug}) Check if the URL is correct or if the profile is strictly private.`);
  }
  return {
    name: p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim(),
    headline: p.headline || "",
    about: (p.about || p.summary || "").slice(0, 500),
    edu: (p.education || p.educations || []).map(e => ({
      s: e.schoolName || e.school || "", d: e.degreeName || e.degree || "",
      f: e.fieldOfStudy || e.field || "",
    })).slice(0, 3),
    exp: (p.experience || p.experiences || p.positions || []).slice(0, 5).map(e => ({
      co: e.companyName || e.company || "", role: e.title || e.position || "",
      dur: e.duration || "",
    })),
  };
}

// ── company scrape cache (localStorage) ──────────────────────────────────────
const EMP_CACHE_KEY = "hs_emp_cache";
function getCachedEmp(url) {
  try {
    const c = JSON.parse(localStorage.getItem(EMP_CACHE_KEY) || "{}");
    return c[normCompanyUrl(url)] || null;
  } catch { return null; }
}
function setCachedEmp(url, data) {
  try {
    const c = JSON.parse(localStorage.getItem(EMP_CACHE_KEY) || "{}");
    c[normCompanyUrl(url)] = data;
    localStorage.setItem(EMP_CACHE_KEY, JSON.stringify(c));
  } catch {}
}

// ── prompt ────────────────────────────────────────────────────────────────────
function buildPrompt({ companyName, count, profiles, performer, hmName }) {
  const tpFirst = performer?.name?.split(" ")[0] || "this person";
  const hmFirst = hmName?.split(" ")[0] || hmName;

  return `You are a calm, composed, classy, and highly professional talent strategist. You are helping craft a personalized outbound email to "${hmName}" — a hiring decision-maker at "${companyName}" (a startup based in Bangalore, India).

You have two data sources:

1. ENGINEERING TEAM DATA (${count} engineering profiles from a partial LinkedIn scrape — NOTE: these are ONLY engineers, filtered by Engineering function):
${JSON.stringify(profiles)}

2. TOP PERFORMER PROFILE — "${performer?.name}" (a high-performing engineer who has stayed at ${companyName} for a couple of years — the leadership knows this person well):
${JSON.stringify(performer)}

FIRST: Use Google Search to precisely identify what "${companyName}" (a startup based in Bangalore, India) actually builds or does (their core product, macro-industry, and true business identity).

YOUR TASKS:

TASK 1 — ENGINEERING HIRING DNA (3-4 patterns):
Extract the company's core ENGINEERING hiring patterns. You ONLY have engineering profiles. Do NOT comment on other functions.

MANDATORY FIXED PATTERNS (you MUST cover all 3):

a) Startup Pipeline: These are Bangalore startups — their engineers almost always come from OTHER startups. Identify the EXACT previous startups that appear most frequently in the data. List the actual company names you see (e.g., "Spinny, Razorpay, Classplus"). If some engineers come from larger companies, only mention those as secondary.

b) Experience Level: State the career stages and seniority. Are they early-career (0-3 yrs)? Mid-career (3-7 yrs)? Senior (7+)? Be specific about the band.

c) Academic Pedigree: Identify the EXACT colleges and institutes that appear in the education data. Name them explicitly (e.g., "IIT Delhi, IIT Bombay, BITS Pilani, NIT Trichy"). NEVER say "a premier institute" or "top-tier institute". Always name names.

OPTIONAL 4th PATTERN: If the data reveals another strong, distinct pattern, add it. eg: Can be current role names. If nothing compelling exists, output only 3 patterns.

RULES:
- CLASSY & WITTY TITLES for each pattern. DO NOT prefix with labels like "Domain Focus:" or "Experience:". Just the copy itself.
- HYPER-SPECIFIC EVIDENCE: Exactly 1 sentence (max 25 words). MUST name exact companies, exact institutes, or exact tools found in the data. NEVER use vague phrases like "a premier institute", "top-tier companies", "leading startups", or "a single institute of technology". Always name names.
- PROPORTIONAL LANGUAGE (NO PERCENTAGES). Use "An overwhelming majority", "A strong concentration", etc.
- ONLY USE DATA YOU HAVE. Never reference or speculate about non-engineering roles.
- No Geography/Location mentions.

TASK 2 — COMPANY ADJECTIVES:
Based on your Google Search and the data, generate exactly 1-2 adjectives that describe ${companyName}'s engineering culture or domain focus. These will be used in the email template. Examples: "consumer-first", "AI-native", "infra-heavy", "fintech-grade", "defense-focused", "healthtech-driven". Keep them short, punchy, and accurate.

TASK 3 — EMAIL DRAFT:
Generate the email using this EXACT template. Fill in the blanks marked with <...>. Do NOT deviate from this structure:

Subject: "${hmFirst}, I found you another ${tpFirst}..."

Body:
Hey ${hmFirst},

Gaurika here from Tal (by Grapevine). We help companies like you hire talent that fits your <adjective1>, <adjective2> taste.

I have attached a small analysis snippet of your engineering hiring DNA at ${companyName}.

I talk to engineers all day, and I found a rare gem - he's exactly like ${performer?.name} - one of your top engineers.

I have also attached his resume, let me know if you'd like me to make a connect.

Best,
Gaurika

IMPORTANT: Follow this email template EXACTLY. Only replace <adjective1> and <adjective2> with the adjectives from Task 2. Do NOT add or remove any lines. Do NOT change the wording.

TASK 4 — RATIONALE:
Explain your reasoning in 3-5 sentences. List the exact raw data points you used: which company names appeared most in previous experience, which institutes appeared in education, which skills appeared in current roles. Why did you pick these specific DNA patterns? This is for internal debugging — be extremely specific about the data.

Return ONLY raw JSON, no markdown:
{"company_name":"${companyName}","company_hiring_dna":[{"pattern":"Classy Title","evidence":"Short evidence with exact names."}],"adjectives":["adj1","adj2"],"email_subject":"${hmFirst}, I found you another ${tpFirst}...","email_body":"The full email body text.","rationale":"3-5 data-heavy sentences."}`;
}

// ── design tokens ─────────────────────────────────────────────────────────────
const T = {
  bg: "#F6F4EF", surface: "#FDFCF9", border: "#E2DED7", borderDark: "#C8C3BB",
  ink: "#1C1917", inkMid: "#6B6560", inkLight: "#A8A39D",
  accent: "#1B3A28", accentLight: "#2D5C40", gold: "#B8922A",
  red: "#8B2020", green: "#1B3A28",
};
const S = {
  label: {
    fontFamily: "'DM Mono', monospace", fontSize: "10px", letterSpacing: "0.18em",
    textTransform: "uppercase", color: T.inkLight, fontWeight: 500,
  },
  sectionTitle: {
    fontFamily: "'Cormorant Garamond', serif", fontSize: "22px", fontWeight: 600,
    color: T.ink, letterSpacing: "-0.01em",
  },
  body: {
    fontFamily: "'DM Sans', sans-serif", fontSize: "14px", lineHeight: 1.65, color: T.inkMid,
  },
};

// ── sub-components ────────────────────────────────────────────────────────────
function Pill({ children, color = T.inkLight }) {
  return (
    <span style={{
      display: "inline-block", fontFamily: "'DM Mono', monospace", fontSize: "10px",
      letterSpacing: "0.06em", padding: "3px 10px", border: `1px solid ${color}44`,
      borderRadius: "2px", color, background: `${color}08`,
    }}>{children}</span>
  );
}

function Divider({ margin = "24px 0" }) {
  return <div style={{ borderTop: `1px solid ${T.border}`, margin }} />;
}

function CopyBtn({ text, label = "COPY" }) {
  const [ok, setOk] = useState(false);
  const go = () => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 2000); };
  return (
    <button onClick={go} style={{
      border: `1px solid ${ok ? T.green : T.border}`, background: ok ? "rgba(27,58,40,0.06)" : "none",
      color: ok ? T.green : T.inkLight, padding: "6px 14px", borderRadius: "2px",
      fontFamily: "'DM Mono', monospace", fontSize: "10px", letterSpacing: "0.1em",
      cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap",
    }}>{ok ? "COPIED ✓" : label}</button>
  );
}

function StatusDot({ state }) {
  const colors = { idle: T.border, active: T.gold, done: T.green, error: T.red };
  const c = colors[state] || T.border;
  return (
    <div style={{
      width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
      background: state === "idle" ? "none" : c,
      border: `1.5px solid ${c}`,
      animation: state === "active" ? "pulse 1.2s ease-in-out infinite" : "none",
    }} />
  );
}

function InputField({ label, value, onChange, placeholder, mono }) {
  return (
    <div style={{ marginBottom: "24px" }}>
      <div style={{ ...S.label, marginBottom: "8px" }}>{label}</div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", border: `1.5px solid ${T.border}`, borderRadius: "4px",
          padding: "14px 16px", background: T.surface,
          fontFamily: mono ? "'DM Mono', monospace" : "'DM Sans', sans-serif",
          fontSize: mono ? "12px" : "14px", color: T.ink, outline: "none",
          transition: "border 0.2s",
        }}
        onFocus={e => e.target.style.borderColor = T.ink}
        onBlur={e => e.target.style.borderColor = T.border}
      />
    </div>
  );
}

// ── main ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [step, setStep] = useState(1);
  const [hmName, setHmName] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [performerUrl, setPerformerUrl] = useState("");

  const [status, setStatus] = useState({ employees: "idle", performer: "idle", analysis: "idle" });
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const updateStatus = (key, val) => setStatus(prev => ({ ...prev, [key]: val }));
  const canGenerate = hmName.trim() && companyUrl.trim() && performerUrl.trim();

  const generate = async () => {
    setStep(2);
    setError("");
    setResult(null);
    setStatus({ employees: "active", performer: "active", analysis: "idle" });

    try {
      // ── check cache for company employees ──
      const cached = getCachedEmp(companyUrl);
      let empPromise;
      if (cached) {
        updateStatus("employees", "done");
        empPromise = Promise.resolve(cached);
      } else {
        empPromise = scrapeActor("harvestapi~linkedin-company-employees", {
          maxItems: 25,
          companies: [normCompanyUrl(companyUrl)],
          functionFilter: ["Engineering"],
          recentlyChangedJobsFilter: true,
        }).then(data => {
          setCachedEmp(companyUrl, data);
          updateStatus("employees", "done");
          return data;
        }).catch(e => { updateStatus("employees", "error"); throw new Error(`Company scrape: ${e.message}`); });
      }

      const perfNormUrl = normProfileUrl(performerUrl);
      const perfPromise = scrapeActor("dev_fusion~linkedin-profile-scraper", {
        profileUrls: [perfNormUrl],
      }).then(async data => {
        // Fallback: If dev_fusion fails to find the profile (returns empty),
        // try harvestapi's dedicated profile scraper instead.
        if (!data || !Array.isArray(data) || data.length === 0) {
          return scrapeActor("harvestapi~linkedin-profile-scraper", { url: perfNormUrl });
        }
        return data;
      })
      .then(data => { updateStatus("performer", "done"); return data; })
      .catch(e => { updateStatus("performer", "error"); throw new Error(`Profile scrape: ${e.message}`); });

      const [empRaw, perfRaw] = await Promise.all([empPromise, perfPromise]);

      // ── process ──
      updateStatus("analysis", "active");
      const emp = slimEmployees(empRaw);
      const perf = slimPerformer(perfRaw, perfNormUrl);
      const prompt = buildPrompt({
        companyName: emp.companyName,
        count: emp.count,
        profiles: emp.profiles,
        performer: perf,
        hmName: hmName.trim(),
      });

      // ── gemini ──
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: prompt }] },
            contents: [{ role: "user", parts: [{ text: "Generate the hiring DNA analysis and email draft based on all the data provided." }] }],
            tools: [{ googleSearch: {} }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 8000 },
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `Gemini error ${res.status}`);
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`Bad AI response: ${raw.slice(0, 200)}`);
      // Strip Gemini grounding citations like [1], [1.3], [2,3] from all string values
      const cleanCitations = (obj) => {
        if (typeof obj === "string") return obj.replace(/\s*\[\d+(?:[.,]\d+)*\]/g, "");
        if (Array.isArray(obj)) return obj.map(cleanCitations);
        if (obj && typeof obj === "object") {
          const out = {};
          for (const k in obj) out[k] = cleanCitations(obj[k]);
          return out;
        }
        return obj;
      };
      const parsed = cleanCitations(JSON.parse(jsonMatch[0]));

      updateStatus("analysis", "done");
      setResult(parsed);
      setStep(3);
    } catch (e) {
      setError(e.message);
    }
  };

  const reset = () => {
    setStep(1); setHmName(""); setCompanyUrl(""); setPerformerUrl("");
    setStatus({ employees: "idle", performer: "idle", analysis: "idle" });
    setResult(null); setError("");
  };

  const tryAnother = () => {
    setStep(1); setResult(null); setError("");
    setStatus({ employees: "idle", performer: "idle", analysis: "idle" });
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${T.bg}; }
        input { outline: none; }
        button { cursor: pointer; outline: none; }
        .fade { animation: fadeIn 0.4s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
        .pri-btn { border: 1.5px solid ${T.ink}; background: ${T.ink}; color: ${T.bg}; padding: 14px 36px; border-radius: 2px; font-family: 'DM Mono', monospace; font-size: 11px; letter-spacing: 0.14em; transition: all 0.15s; }
        .pri-btn:hover { background: ${T.accent}; border-color: ${T.accent}; }
        .pri-btn:disabled { background: none; color: ${T.inkLight}; border-color: ${T.border}; cursor: default; }
        .ghost-btn { border: 1px solid ${T.border}; background: none; color: ${T.inkLight}; padding: 12px 24px; border-radius: 2px; font-family: 'DM Mono', monospace; font-size: 11px; letter-spacing: 0.1em; transition: all 0.15s; }
        .ghost-btn:hover { border-color: ${T.inkMid}; color: ${T.ink}; }
      `}</style>

      <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'DM Sans', sans-serif" }}>

        {/* ── Header ── */}
        <div style={{
          borderBottom: `1px solid ${T.border}`, padding: "20px 48px",
          display: "flex", alignItems: "center", justifyContent: "space-between", background: T.surface,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "16px" }}>
            <span style={{
              fontFamily: "'Cormorant Garamond', serif", fontSize: "18px",
              fontWeight: 600, color: T.ink, letterSpacing: "-0.01em",
            }}>Hiring Signal</span>
            <span style={{ ...S.label, color: T.inkLight }}>Outbound Pitch Generator</span>
          </div>
          {step > 1 && <button onClick={reset} className="ghost-btn">RESET</button>}
        </div>

        {/* ── Steps bar ── */}
        <div style={{
          borderBottom: `1px solid ${T.border}`, padding: "14px 48px",
          display: "flex", gap: "32px", alignItems: "center", background: T.surface,
        }}>
          {["Target Details", "Scrape & Analyze", "Pitch Ready"].map((s, i) => {
            const n = i + 1;
            const active = step === n;
            const done = step > n;
            return (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div style={{
                  width: 20, height: 20, borderRadius: "50%",
                  border: `1.5px solid ${active || done ? T.ink : T.border}`,
                  background: done ? T.ink : "none",
                  display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s",
                }}>
                  {done
                    ? <span style={{ color: T.bg, fontSize: "10px" }}>✓</span>
                    : <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: active ? T.ink : T.inkLight }}>{n}</span>
                  }
                </div>
                <span style={{ ...S.label, color: active ? T.ink : done ? T.inkMid : T.inkLight, letterSpacing: "0.1em" }}>{s}</span>
                {i < 2 && <div style={{ width: 24, height: 1, background: T.border, marginLeft: "8px" }} />}
              </div>
            );
          })}
        </div>

        {/* ── Body ── */}
        <div style={{ maxWidth: "860px", margin: "0 auto", padding: "60px 48px" }}>

          {/* ═══ STEP 1 — Input ═══ */}
          {step === 1 && (
            <div className="fade">
              <div style={S.label}>Step 01</div>
              <h2 style={{ ...S.sectionTitle, fontSize: "32px", marginTop: "8px", marginBottom: "8px" }}>
                Enter target details
              </h2>
              <p style={{ ...S.body, marginBottom: "40px" }}>
                Provide the hiring manager's name, the company's LinkedIn page URL, and the top performer's LinkedIn profile URL.
              </p>

              <InputField
                label="Hiring Manager Name"
                value={hmName}
                onChange={setHmName}
                placeholder="e.g. Kedar Kulkarni"
              />
              <InputField
                label="Company LinkedIn URL"
                value={companyUrl}
                onChange={setCompanyUrl}
                placeholder="e.g. https://www.linkedin.com/company/hyperverge/"
                mono
              />
              <InputField
                label="Top Performer LinkedIn URL"
                value={performerUrl}
                onChange={setPerformerUrl}
                placeholder="e.g. https://www.linkedin.com/in/murchanaa-adhikary-44822a61/"
                mono
              />

              <div style={{ marginTop: "12px" }}>
                <button className="pri-btn" onClick={generate} disabled={!canGenerate}>
                  GENERATE PITCH →
                </button>
              </div>
            </div>
          )}

          {/* ═══ STEP 2 — Processing ═══ */}
          {step === 2 && (
            <div className="fade">
              <div style={S.label}>Step 02</div>
              <h2 style={{ ...S.sectionTitle, fontSize: "32px", marginTop: "8px", marginBottom: "8px" }}>
                Gathering intelligence
              </h2>
              <p style={{ ...S.body, marginBottom: "40px" }}>
                Running LinkedIn scrapes and AI analysis. This typically takes 30–90 seconds.
              </p>

              <div style={{
                border: `1px solid ${T.border}`, borderRadius: "4px", padding: "28px 32px",
                background: T.surface,
              }}>
                {[
                  { key: "employees", label: "Scraping company employees", sub: "harvestapi · max 25 profiles" },
                  { key: "performer", label: "Scraping top performer profile", sub: "dev_fusion · detailed profile" },
                  { key: "analysis", label: "AI analysis & email generation", sub: "gemini · DNA + email draft" },
                ].map(({ key, label, sub }) => (
                  <div key={key} style={{
                    display: "flex", alignItems: "center", gap: "16px",
                    padding: "16px 0",
                    borderBottom: key !== "analysis" ? `1px solid ${T.border}` : "none",
                    opacity: status[key] === "idle" ? 0.4 : 1,
                    transition: "opacity 0.3s",
                  }}>
                    <StatusDot state={status[key]} />
                    <div>
                      <div style={{ ...S.body, color: T.ink, fontWeight: 500, fontSize: "14px" }}>{label}</div>
                      <div style={{ ...S.label, marginTop: "4px", fontSize: "9px" }}>{sub}</div>
                    </div>
                    {status[key] === "active" && (
                      <span style={{ ...S.label, marginLeft: "auto", color: T.gold, fontSize: "9px" }}>
                        RUNNING
                      </span>
                    )}
                    {status[key] === "done" && (
                      <span style={{ ...S.label, marginLeft: "auto", color: T.green, fontSize: "9px" }}>
                        DONE
                      </span>
                    )}
                    {status[key] === "error" && (
                      <span style={{ ...S.label, marginLeft: "auto", color: T.red, fontSize: "9px" }}>
                        FAILED
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {!error && (
                <div style={{ marginTop: "24px" }}>
                  <div style={{
                    width: "100%", height: "2px", background: T.border, borderRadius: "1px", overflow: "hidden",
                  }}>
                    <div style={{
                      height: "100%", width: "40%", background: T.ink,
                      animation: "slide 1.2s ease-in-out infinite", borderRadius: "1px",
                    }} />
                  </div>
                </div>
              )}

              {error && (
                <div style={{
                  marginTop: "24px", padding: "16px 20px", borderRadius: "4px",
                  background: "rgba(139,32,32,0.05)", border: "1px solid rgba(139,32,32,0.2)",
                }}>
                  <div style={{ ...S.body, color: T.red, fontSize: "13px", fontWeight: 500 }}>
                    ⚠ {error}
                  </div>
                  <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
                    <button className="pri-btn" onClick={generate}>RETRY</button>
                    <button className="ghost-btn" onClick={tryAnother}>← BACK</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ STEP 3 — Results ═══ */}
          {step === 3 && result && (
            <div className="fade">

              {/* ── Email Draft ── */}
              <div style={S.label}><span style={{ color: T.green, marginRight: "6px" }}>●</span>Email Draft</div>
              <div style={{
                border: `1px solid ${T.border}`, borderRadius: "4px", marginTop: "16px",
                background: T.surface, overflow: "hidden",
              }}>
                {/* Subject */}
                <div style={{
                  padding: "20px 24px", borderBottom: `1px solid ${T.border}`,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <div>
                    <div style={{ ...S.label, marginBottom: "6px" }}>Subject</div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: "16px",
                      fontWeight: 500, color: T.ink,
                    }}>{result.email_subject}</div>
                  </div>
                  <CopyBtn text={result.email_subject} />
                </div>

                {/* Body */}
                <div style={{ padding: "20px 24px" }}>
                  <div style={{
                    display: "flex", alignItems: "flex-start", justifyContent: "space-between",
                    gap: "20px",
                  }}>
                    <div>
                      <div style={{ ...S.label, marginBottom: "10px" }}>Body</div>
                      <div style={{
                        fontFamily: "'DM Sans', sans-serif", fontSize: "14px",
                        lineHeight: 1.8, color: T.ink, whiteSpace: "pre-wrap", maxWidth: "600px",
                      }}>{result.email_body}</div>
                    </div>
                    <CopyBtn text={result.email_body} />
                  </div>
                </div>

                {/* Full copy */}
                <div style={{
                  padding: "14px 24px", borderTop: `1px solid ${T.border}`,
                  display: "flex", justifyContent: "flex-end",
                }}>
                  <CopyBtn
                    text={`Subject: ${result.email_subject}\n\n${result.email_body}`}
                    label="COPY FULL EMAIL"
                  />
                </div>
              </div>

              <Divider margin="40px 0" />

              {/* ── Hiring DNA ── */}
              {result.company_hiring_dna?.length > 0 && (
                <div style={{ margin: "40px 0" }}>
                  <div style={{
                    fontFamily: "'Cormorant Garamond', serif", fontSize: "26px",
                    fontWeight: 700, color: T.ink, letterSpacing: "-0.01em", marginBottom: "20px",
                  }}>Engineering Hiring DNA - {result.company_name}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: T.border }}>
                    {result.company_hiring_dna.map((b, i) => (
                      <div key={i} style={{
                        background: T.surface, padding: "18px 24px",
                        display: "grid", gridTemplateColumns: "200px 1fr", gap: "24px",
                      }}>
                        <div style={{
                          fontFamily: "'DM Mono', monospace", fontSize: "14px",
                          color: T.ink, fontWeight: 600, letterSpacing: "0.05em", paddingTop: "2px",
                        }}>{b.pattern}</div>
                        <div style={{ ...S.body, fontSize: "13px" }}>{b.evidence}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Divider />

              {/* ── Rationale (Debug) ── */}
              {result.rationale && (
                <div style={{ margin: "40px 0" }}>
                  <div style={S.label}>Rationale (debug)</div>
                  <div style={{
                    marginTop: "12px", padding: "20px", borderRadius: "4px",
                    background: "rgba(27,58,40,0.03)", border: `1px solid rgba(27,58,40,0.12)`,
                  }}>
                    <p style={{
                      ...S.body, fontSize: "13px", color: T.inkMid, lineHeight: 1.8,
                      whiteSpace: "pre-wrap",
                    }}>{result.rationale}</p>
                  </div>
                </div>
              )}

              <Divider />

              {/* ── Actions ── */}
              <div style={{ display: "flex", gap: "12px", marginTop: "32px" }}>
                <button className="pri-btn" onClick={tryAnother}>GENERATE ANOTHER PITCH</button>
                <button className="ghost-btn" onClick={reset}>RESET ALL</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
