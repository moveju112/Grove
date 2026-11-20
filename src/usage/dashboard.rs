//! 기존 사용량 원장을 한 번 읽어 공급자·모델·시간대별로 같은 기준으로 투영한다.
use super::*;
use serde::Serialize;

#[derive(Clone, Default, Serialize, ts_rs::TS)]
pub struct UsageMetrics {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_write_unreported_responses: u64,
    pub reasoning_unreported_responses: u64,
    pub responses: u64,
    pub unreported_responses: u64,
    pub measured_responses: u64,
    pub measured_output_tokens: u64,
    pub response_ms: u64,
    pub cli_measured_responses: u64,
    pub tok_per_second: Option<f64>,
    pub low10_tok_per_second: Option<f64>,
    pub high10_tok_per_second: Option<f64>,
    #[serde(skip)]
    #[ts(skip)]
    speed_samples: Vec<f64>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct UsageSlice {
    pub key: String,
    pub label: String,
    pub provider: String,
    pub metrics: UsageMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context: Option<UsageEffortContext>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct UsageEffortContext {
    pub agent: Option<String>,
    pub model: String,
    pub effort: Option<String>,
    pub fast: Option<bool>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct UsageBucket {
    pub start: String,
    pub total: UsageMetrics,
    pub providers: Vec<UsageSlice>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct UsageDashboard {
    pub from: String,
    pub to: String,
    pub interval: String,
    pub total: UsageMetrics,
    pub providers: Vec<UsageSlice>,
    pub models: Vec<UsageSlice>,
    pub projects: Vec<UsageSlice>,
    pub agents: Vec<UsageSlice>,
    pub workflows: Vec<UsageSlice>,
    pub sessions: Vec<UsageSlice>,
    pub efforts: Vec<UsageSlice>,
    pub series: Vec<UsageBucket>,
    pub estimated_cost: Vec<UsageCost>,
    pub unpriced_tokens: u64,
    pub pricing_versions: Vec<String>,
}

#[derive(Serialize, ts_rs::TS)]
pub struct UsageCost {
    pub currency: String,
    pub amount: f64,
}

impl UsageMetrics {
    fn finish(mut self) -> Self {
        self.speed_samples.sort_by(f64::total_cmp);
        let count = self.speed_samples.len().div_ceil(10);
        if count > 0 {
            self.low10_tok_per_second = Some(self.speed_samples[..count].iter().sum::<f64>() / count as f64);
            self.high10_tok_per_second = Some(self.speed_samples[self.speed_samples.len() - count..].iter().sum::<f64>() / count as f64);
        }
        self.speed_samples.clear();
        self
    }

    fn add(&mut self, content: &Value, protocol: &str) {
        let usage = &content["usage"];
        let input = usage["input_tokens"].as_u64();
        let output = usage["output_tokens"].as_u64();
        self.input_tokens += input.unwrap_or(0);
        self.output_tokens += output.unwrap_or(0);
        self.cache_read_tokens += usage["cache_read_tokens"].as_u64().unwrap_or(0);
        self.cache_write_tokens += usage["cache_write_tokens"].as_u64().unwrap_or(0);
        self.reasoning_tokens += usage["reasoning_tokens"].as_u64().unwrap_or(0);
        self.cache_write_unreported_responses += u64::from(usage["cache_write_tokens"].as_u64().is_none());
        self.reasoning_unreported_responses += u64::from(usage["reasoning_tokens"].as_u64().is_none());
        self.responses += 1;
        self.unreported_responses += u64::from(input.is_none() || output.is_none());
        // 전체 턴 시간(provider_ms)은 CLI 내 도구 실행 등을 포함한다. 과거 기록도 대체값으로 쓰지 않는다.
        if let (Some(output), Some(ms)) = (output.filter(|n| *n > 0), usage["model_request_ms"].as_u64().filter(|n| *n > 0)) {
            self.speed_samples.push(output as f64 * 1000.0 / ms as f64);
            self.measured_responses += 1;
            self.measured_output_tokens += output;
            self.response_ms += ms;
            self.cli_measured_responses += u64::from(crate::provider::cli::is_cli(protocol));
        }
        self.tok_per_second = (self.response_ms > 0).then(|| self.measured_output_tokens as f64 * 1000.0 / self.response_ms as f64);
    }
}

type Slices = BTreeMap<(String, String, String), UsageMetrics>;

fn add(map: &mut Slices, key: &str, label: &str, protocol: &str, content: &Value) {
    map.entry((key.into(), label.into(), protocol.into())).or_default().add(content, protocol);
}

fn slices(map: Slices) -> Vec<UsageSlice> {
    let mut rows: Vec<_> = map.into_iter().map(|((key, label, provider), metrics)| UsageSlice { key, label, provider, metrics: metrics.finish(), context: None }).collect();
    rows.sort_by(|a, b| (b.metrics.input_tokens + b.metrics.output_tokens).cmp(&(a.metrics.input_tokens + a.metrics.output_tokens)).then(a.key.cmp(&b.key)));
    rows
}

pub(super) struct Builder {
    from: OffsetDateTime,
    to: OffsetDateTime,
    offset: i64,
    step: i64,
    total: UsageMetrics,
    cost: Acc,
    pricing_versions: std::collections::BTreeSet<String>,
    providers: Slices,
    models: Slices,
    projects: Slices,
    agents: Slices,
    workflows: Slices,
    sessions: Slices,
    efforts: Slices,
    effort_contexts: BTreeMap<String, UsageEffortContext>,
    series: BTreeMap<i64, (UsageMetrics, Slices)>,
}

impl Builder {
    pub(super) fn new(from: OffsetDateTime, to: OffsetDateTime, offset: UtcOffset, hourly: bool) -> Self {
        Self { from, to, offset: i64::from(offset.whole_seconds()), step: if hourly { 3600 } else { 86400 },
            total: UsageMetrics::default(), cost: Acc::default(), pricing_versions: Default::default(), providers: Slices::new(), models: Slices::new(), projects: Slices::new(),
            agents: Slices::new(), workflows: Slices::new(), sessions: Slices::new(), efforts: Slices::new(), effort_contexts: BTreeMap::new(), series: BTreeMap::new() }
    }

    fn slot(&self, time: OffsetDateTime) -> i64 {
        (time.unix_timestamp() + self.offset).div_euclid(self.step) * self.step - self.offset
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn add(&mut self, at: &str, content: &Value, pricing: Option<&Value>, protocol: &str,
        agent: Option<&str>, workflow: Option<&str>, project_id: &str, project: &str, session_id: &str, session: &str) {
        // 새 기록은 호출 당시 protocol을 보존한다. 삭제·수정된 프로필도 공급자가 바뀌지 않는다.
        let protocol = content["protocol"].as_str().unwrap_or(protocol);
        let model = content["model"].as_str().unwrap_or("모델 미기록");
        self.total.add(content, protocol);
        self.cost.add(&content["usage"], pricing);
        if let Some(version) = pricing.and_then(|p| p["version"].as_str()) { self.pricing_versions.insert(version.into()); }
        add(&mut self.providers, protocol, protocol, protocol, content);
        add(&mut self.models, model, model, protocol, content);
        add(&mut self.projects, project_id, project, protocol, content);
        add(&mut self.agents, agent.unwrap_or("미기록"), agent.unwrap_or("미기록"), protocol, content);
        add(&mut self.workflows, workflow.unwrap_or("미기록"), workflow.unwrap_or("미기록"), protocol, content);
        add(&mut self.sessions, session_id, session, protocol, content);
        let effort = content["effort"].as_str().unwrap_or("미기록");
        let tier = content["service_tier"].as_str().unwrap_or("미기록");
        let label = format!("{model} · {effort} · Fast {tier}");
        let key = json!([protocol, model, agent, effort, tier]).to_string();
        add(&mut self.efforts, &key, &label, protocol, content);
        self.effort_contexts.entry(key).or_insert_with(|| UsageEffortContext {
            agent: agent.map(str::to_owned), model: model.to_owned(), effort: content["effort"].as_str().map(str::to_owned),
            fast: match content["service_tier"].as_str() { Some("priority" | "fast") => Some(true), Some("default" | "standard") => Some(false), _ => None },
        });
        if let Some(time) = crate::util::parse_time(at) {
            let slot = self.slot(time);
            let (total, providers) = self.series.entry(slot).or_default();
            total.add(content, protocol);
            add(providers, protocol, protocol, protocol, content);
        }
    }

    pub(super) fn finish(mut self) -> UsageDashboard {
        // 빈 시간대도 보존한다. 속도 미측정 구간은 null이며 선으로 이어 붙이지 않는다.
        let mut slot = self.slot(self.from);
        while slot < self.to.unix_timestamp() {
            self.series.entry(slot).or_default();
            slot += self.step;
        }
        let mut efforts = slices(self.efforts);
        for row in &mut efforts { row.context = self.effort_contexts.remove(&row.key); }
        UsageDashboard {
            from: crate::util::fmt_time(self.from), to: crate::util::fmt_time(self.to), interval: if self.step == 3600 { "hour" } else { "day" }.into(),
            total: self.total.finish(), providers: slices(self.providers), models: slices(self.models), projects: slices(self.projects),
            estimated_cost: self.cost.cost.into_iter().map(|(currency, amount)| UsageCost { currency, amount: (amount * 1_000_000.0).round() / 1_000_000.0 }).collect(),
            unpriced_tokens: self.cost.unpriced_tokens, pricing_versions: self.pricing_versions.into_iter().collect(),
            agents: slices(self.agents), workflows: slices(self.workflows), sessions: slices(self.sessions), efforts,
            series: self.series.into_iter().map(|(slot, (total, providers))| UsageBucket {
                start: crate::util::fmt_time(OffsetDateTime::from_unix_timestamp(slot).expect("validated usage period")), total: total.finish(), providers: slices(providers),
            }).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn speed_uses_matched_output_and_time_without_reusing_turn_totals() {
        let mut metrics = UsageMetrics::default();
        metrics.add(&json!({"usage":{"input_tokens":100,"output_tokens":10,"cache_read_tokens":40,"model_request_ms":1000},"provider_ms":50000}), "openai");
        metrics.add(&json!({"usage":{"input_tokens":20,"output_tokens":90,"model_request_ms":3000},"provider_ms":60000}), "claude_code");
        metrics.add(&json!({"usage":{"input_tokens":200,"output_tokens":900},"provider_ms":2000}), "codex_cli");
        metrics.add(&json!({"provider_ms":5000}), "claude_code");
        assert_eq!(metrics.input_tokens + metrics.output_tokens, 1320);
        assert_eq!(metrics.tok_per_second, Some(25.0));
        let metrics = metrics.finish();
        assert_eq!(metrics.low10_tok_per_second, Some(10.0));
        assert_eq!(metrics.high10_tok_per_second, Some(30.0));
        assert_eq!((metrics.measured_responses, metrics.cli_measured_responses, metrics.responses, metrics.unreported_responses), (2, 1, 4, 1));
        assert_eq!((metrics.measured_output_tokens, metrics.response_ms), (100, 4000));
    }

    #[test]
    fn tail_means_round_samples_up_and_do_not_leak_them() {
        let mut metrics = UsageMetrics::default();
        for output in 1..=11 { metrics.add(&json!({"usage":{"output_tokens":output,"model_request_ms":1000}}), "openai"); }
        let metrics = metrics.finish();
        assert_eq!(metrics.low10_tok_per_second, Some(1.5));
        assert_eq!(metrics.high10_tok_per_second, Some(10.5));
        assert!(serde_json::to_value(&metrics).unwrap().get("speed_samples").is_none());
        assert_eq!(UsageMetrics::default().finish().low10_tok_per_second, None);
    }

    #[test]
    fn projections_keep_provider_identity_and_local_empty_buckets() {
        let mut b = Builder::new(datetime!(2026-11-17 0:30 UTC), datetime!(2026-11-17 3:00 UTC), UtcOffset::from_hms(5, 30, 0).unwrap(), true);
        for protocol in ["codex_cli", "claude_code"] {
            b.add("2026-11-17T01:00:00Z", &json!({"model":"same","protocol":protocol,"usage":{"input_tokens":8,"output_tokens":2},"provider_ms":100}), None, "edited", None, None, "p", "project", "s", "session");
        }
        b.add("2026-11-17T01:00:00Z", &json!({"model":"same","protocol":"codex_cli","effort":"high","service_tier":"priority","usage":{"input_tokens":8,"output_tokens":2},"provider_ms":100}), None, "edited", Some("개발"), None, "p", "project", "s", "session");
        let d = b.finish();
        assert_eq!(d.efforts.len(), 3, "같은 모델의 다른 에이전트·설정을 합치지 않는다");
        let context = d.efforts.iter().find_map(|row| row.context.as_ref().filter(|context| context.agent.as_deref() == Some("개발"))).unwrap();
        assert_eq!(context.model, "same");
        assert_eq!(context.effort.as_deref(), Some("high"));
        assert_eq!(context.fast, Some(true));
        assert_eq!(d.models.len(), 2);
        assert_eq!(d.providers.len(), 2);
        assert_eq!(d.series.len(), 3);
        assert_eq!(d.series[0].start, "2026-11-17T00:30:00Z");
        assert_eq!(d.series[1].total.tok_per_second, None);
        assert_eq!(d.total.input_tokens, d.models.iter().map(|r| r.metrics.input_tokens).sum::<u64>());
    }
}
