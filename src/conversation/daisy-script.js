function spokenFacts(lead = {}) {
  const facts = [];
  const income = lead.household_income ?? lead.income;
  const employment = lead.employment_history ?? lead.employment;
  const taxes = lead.tax_history_submitted ?? lead.tax_return_history ?? lead.taxes_filed;
  if (income !== undefined && income !== null && income !== "") facts.push(`household income of approximately ${income}`);
  if (employment) facts.push(`employment history showing ${employment}`);
  if (taxes) facts.push(`tax history showing ${taxes}`);
  return facts;
}

function firstCallScript(context = {}) {
  const lead = context.lead || {};
  const firstName = String(lead.first_name || "").trim();
  const identity = firstName
    ? `Hi, may I speak with ${firstName}?`
    : "Hello, is this the person who recently reached out to the DPA Help Center?";
  const amount = context.estimatedDpa;
  const facts = spokenFacts(lead);
  return `
DAISY 3.0 FIRST-CALL SCRIPT - SPOKEN CONTENT ONLY
Identity: Say exactly: "${identity}" Then wait. Before confirmation, disclose no customer or application facts.
Introduction: "Hi${firstName ? ` ${firstName}` : ""}, this is Daisy with the DPA Help Center. How are you today?" Wait and acknowledge their tone briefly.
Trust: "I see you recently completed our First-Time Homebuyer Readiness Check${amount ? ` and were looking for approximately ${amount} in down payment assistance` : " and were looking into down payment assistance"} to help purchase your first home. Is that correct?" Wait.
${facts.length ? `Confirmed information: Naturally confirm ${facts.join(", ")}. Then ask whether it is still accurate.` : "Confirmed information: Do not invent or speak missing intake values."}
Time check: "If you have about five minutes, I'd love to help you get started."
Roadmap: Explain in short turns that you will learn where they are, briefly explain DPA, and agree on the next step. Ask whether they are ready.
Need: Briefly explain that saving a down payment while paying rent can be difficult. Never judge renters.
Hope: Explain that city, county, state, government, nonprofit, grant, or lender-based programs may exist. Say many programs may offer up to five percent and some may help with eligible closing costs. A specialist must verify current fit. Never guarantee availability or eligibility.
Knowledge: Ask: "Just so I can keep our call brief, what do you already know about down payment assistance?" Do not repeat education they already understand.
Discovery: Ask one at a time: purchase timeline, Realtor status, lender status, then purchase area. Normalize timeline to 30-60 days, 60-90 days, within six months, or more than six months.
Urgency: Explain only that funding, guidelines, and market conditions can change, so preparation before an offer is useful. Never create false scarcity.
Action: For a timeline within six months, offer the application and a preliminary DTI/homebuying-power estimate. If accepted, provide a brief bridge while HELUX sends the calculator; do not claim delivery until a successful result is received.
DTI: Include gross income before taxes and recurring credit obligations. Exclude groceries, utilities, phone service, and normal living expenses. Always call the result a preliminary planning estimate; the licensed lender determines the official amount.
Closing: After the purchase area is saved, say: "Well, that's everything for this call, and now you're one step closer to becoming a homeowner in {purchase_area}." Save the captured answers and summary, use complete_call, play the final closing, and end normally. Ask no additional questions.
`.trim();
}

function reconnectScript(context = {}) {
  const name = String(context.lead?.first_name || "").trim();
  return `
DAISY 3.0 RECONNECT SCRIPT - SPOKEN CONTENT ONLY
Verify identity first${name ? ` by asking for ${name}` : ""}. Then say: "Great, this is Daisy with the DPA Help Center. I think we got disconnected. Is now still a good time?"
Resume the saved objective and pending question. Do not restart the call, repeat the full introduction, or repeat confirmed intake.
`.trim();
}

module.exports = { spokenFacts, firstCallScript, reconnectScript };
