// Turning adapter records + recorded calls into RL training samples, following
// Sec. 3.3.2 of the paper:
//
//   * a group is one (task, init); only valid attempts count, and G_g >= 2
//   * A_i = R_i - mean(R_k for the other valid attempts in the group)   (Eq. 4)
//   * no critic, no std normalisation; equal-reward groups give no gradient
//   * at most 16 responses per episode, each weighted u_s = 1 / K_i     (Eq. 5)

export function groupKey(r) {
  return `${r.task}#${r.init}`;
}

export function computeAdvantages(adapterRecords) {
  const groups = new Map();
  for (const r of adapterRecords) {
    if (!r.valid) continue;
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const advantage = new Map();
  const groupStats = [];
  for (const [key, members] of groups) {
    const G = members.length;
    const sum = members.reduce((s, m) => s + m.reward, 0);
    const informative = G >= 2 && sum > 0 && sum < G;
    for (const m of members) {
      const A = G >= 2 ? m.reward - (sum - m.reward) / (G - 1) : 0;
      advantage.set(m.episode_id, A);
    }
    groupStats.push({ group: key, size: G, successes: sum, informative });
  }
  return { advantage, groupStats };
}

// Pick up to `cap` turns spread evenly across the episode.
function selectTurns(calls, cap) {
  if (calls.length <= cap) return calls;
  const out = [];
  for (let i = 0; i < cap; i++) out.push(calls[Math.floor((i * calls.length) / cap)]);
  return out;
}

// Each sample's context is (episode briefing, prior turns, current observation);
// the briefing is stored once per episode in briefings.jsonl and referenced by
// episode_id rather than copied into every sample.
export function buildSamples(calls, advantage, { maxPerEpisode = 16 } = {}) {
  const byEpisode = new Map();
  for (const c of calls) {
    if (!byEpisode.has(c.episode_id)) byEpisode.set(c.episode_id, []);
    byEpisode.get(c.episode_id).push(c);
  }
  const samples = [];
  for (const [episodeId, list] of byEpisode) {
    const A = advantage.get(episodeId);
    if (A === undefined || A === 0) continue;   // invalid episode, singleton, or zero-advantage group
    list.sort((a, b) => a.turn - b.turn);
    const chosen = selectTurns(list, maxPerEpisode);
    const weight = 1 / chosen.length;
    for (const c of chosen) {
      // Rebuild the full multi-turn context this response was sampled under.
      const history = list.filter((h) => h.turn < c.turn).map((h) => ({ response: h.response, feedback: h.feedback }));
      samples.push({
        episode_id: episodeId,
        turn: c.turn,
        policy_version: c.policy_version,
        context: { briefing: episodeId, history, observation: c.context.observation },
        response: c.response,
        reasoning: c.reasoning,
        advantage: Number(A.toFixed(4)),
        weight: Number(weight.toFixed(4))
      });
    }
  }
  return samples;
}
