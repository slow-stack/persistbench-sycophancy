r"""E10 EdgeMem 考卷造会话器(确定性,零 LLM)。

设计(plan 2026-10-02):
- 30 会话 = 5 场景 × 6 marker 变体;每会话 4 条**桥接事实**(带唯一 marker 值,
  只被后续 QA 问到——「未来才查询的细节」)+ 6-8 条普通事件事实 + 对话转写。
- 三视图同源:transcript(蒸馏输入)、raw_entries(Z0 原样写入清单)、qa(判卷
  ground truth)。对话由事实清单渲染而来,保证 Z0 的原样条目与转写内容一致。
- QA 问题不含 marker 值(问的就是值);marker 数字边界口径与 E8 一致。
- Z0 条目全部 importance 3、type decision/history——原样写入不做重要度预判,
  这正是 EdgeMem 式写入「不知道未来查询」的含义。

用法: python gen-edgemem-sessions.py(写 data/edgemem_sessions.jsonl)
输出行:{idx, scenario, repeat, transcript, raw_entries:[{type,title,content}],
        qa:[{question, ground_truth, marker, fact_type}]}
"""
import json
import random

rng = random.Random(280750)

SCENARIOS = [
    {
        "name": "kitchen-remodel",
        "bridge": [
            ("The sound system got exactly {v1} of the remodeling budget.", "decision", "sound system budget",
             "How much of the remodeling budget went to the sound system?"),
            ("The tile order is scheduled to arrive on {v2}.", "decision", "tile order arrival",
             "When is the tile order scheduled to arrive?"),
            ("The cabinet installer charges {v3} per day.", "decision", "installer daily rate",
             "What does the cabinet installer charge per day?"),
            ("The backsplash needs {v4} square feet of tile.", "decision", "backsplash tile quantity",
             "How many square feet of tile does the backsplash need?"),
        ],
        "variants": {
            "v1": ["$2,850", "$3,100", "$2,400", "$2,950", "$3,300", "$2,650"],
            "v2": ["March 14", "April 2", "March 28", "April 9", "March 21", "April 16"],
            "v3": ["$340", "$310", "$360", "$290", "$330", "$380"],
            "v4": ["38", "42", "35", "45", "40", "36"],
        },
        "event_facts": [
            ("history", "demo finished early", "The kitchen demo crew finished ahead of schedule."),
            ("history", "cabinet delivery", "The kitchen cabinets arrive on Thursday."),
            ("history", "painter schedule", "The painter is booked for after the drywall cures."),
            ("history", "quote count", "Three contractor quotes were gathered before demolition."),
            ("history", "template booking", "The countertop template appointment is confirmed."),
            ("history", "fixture timing", "Small fixtures are planned last, after the big surfaces are set."),
        ],
        "wrap": "Quick update on the remodel — {fact}",
    },
    {
        "name": "dev-certification",
        "bridge": [
            ("The practice exam voucher costs {v1}.", "decision", "voucher cost",
             "How much does the practice exam voucher cost?"),
            ("The exam registration deadline is {v2}.", "decision", "registration deadline",
             "When is the exam registration deadline?"),
            ("The study plan allocates {v3} hours to networking.", "decision", "networking hours",
             "How many hours does the study plan allocate to networking?"),
            ("The certification exam has {v4} questions in total.", "decision", "exam question count",
             "How many questions does the certification exam have?"),
        ],
        "variants": {
            "v1": ["$85", "$70", "$95", "$80", "$75", "$90"],
            "v2": ["June 5", "May 22", "June 12", "May 29", "June 3", "May 26"],
            "v3": ["18", "22", "15", "20", "24", "16"],
            "v4": ["65", "60", "70", "55", "75", "68"],
        },
        "event_facts": [
            ("history", "lab hygiene", "A lab teardown script wipes cloud resources nightly."),
            ("history", "first mock done", "The first full practice test has been completed."),
            ("history", "weak domain", "Networking is the weakest exam domain so far."),
            ("history", "study cadence", "Study happens in the same daily time slot."),
            ("history", "final week rule", "The final week is notes-only review, no new material."),
            ("history", "domain tracking", "Weak areas are tracked per exam domain and revisited weekly."),
        ],
        "wrap": "Study note — {fact}",
    },
    {
        "name": "wedding-toast",
        "bridge": [
            ("The reception hall seats {v1} guests.", "decision", "hall capacity",
             "How many guests does the reception hall seat?"),
            ("The couple's first dance song is {v2} minutes long.", "decision", "first dance length",
             "How long is the couple's first dance song?"),
            ("The group gift contribution is {v3} per person.", "decision", "gift contribution",
             "How much is the group gift contribution per person?"),
            ("The photographer charges {v4} for the full day.", "decision", "photographer fee",
             "How much does the photographer charge for the full day?"),
        ],
        "variants": {
            "v1": ["120", "140", "100", "150", "110", "130"],
            "v2": ["3", "4", "2", "5", "3", "4"],
            "v3": ["$45", "$50", "$40", "$55", "$35", "$60"],
            "v4": ["$1,850", "$2,100", "$1,600", "$1,950", "$2,300", "$1,750"],
        },
        "event_facts": [
            ("history", "purple garage story", "The toast opens with the story about painting the garage purple."),
            ("history", "toast structure", "The toast follows three beats: anecdote, admiration, closing wish."),
            ("history", "second anecdote cut", "The second anecdote was cut; only the purple garage remains."),
            ("history", "rehearsal mode", "Rehearsal is done standing up and out loud with a timer."),
            ("history", "closing rule", "The toast ends on the couple with one sincere sentence."),
            ("history", "edit freeze", "The toast text is locked; no more editing passes."),
        ],
        "wrap": "Wedding logistics — {fact}",
    },
    {
        "name": "salon-launch",
        "bridge": [
            ("The salon has {v1} styling stations.", "decision", "station count",
             "How many styling stations does the salon have?"),
            ("The soft opening is set for {v2}.", "decision", "soft opening date",
             "When is the soft opening?"),
            ("The senior stylist starts at {v3} per month.", "decision", "stylist salary",
             "What is the senior stylist's monthly pay?"),
            ("The initial product order totals {v4}.", "decision", "product order total",
             "How much is the initial product order?"),
        ],
        "variants": {
            "v1": ["6", "8", "5", "7", "9", "4"],
            "v2": ["October 18", "November 1", "October 25", "November 8", "October 11", "November 15"],
            "v3": ["$3,200", "$3,500", "$2,900", "$3,800", "$3,100", "$3,400"],
            "v4": ["$4,600", "$5,200", "$4,100", "$4,900", "$5,500", "$4,300"],
        },
        "event_facts": [
            ("history", "insurance done", "The salon insurance is quoted and the lease is signed."),
            ("history", "senior hire", "One senior stylist has been hired as the quality anchor."),
            ("history", "backbar first", "Backbar essentials are ordered before retail shelves."),
            ("history", "check-in dry run", "A full check-in dry run found and fixed two hiccups."),
            ("history", "marketing timing", "Marketing starts two weeks before opening with three posts ready."),
            ("history", "pricing method", "Pricing is benchmarked against three local salons, set under midpoint."),
        ],
        "wrap": "Launch logistics — {fact}",
    },
    {
        "name": "van-conversion",
        "bridge": [
            ("The battery bank stores {v1} watt-hours.", "decision", "battery capacity",
             "How many watt-hours does the battery bank store?"),
            ("The van gets its fresh coat of paint in {v2}.", "decision", "paint timing",
             "When does the van get painted?"),
            ("The insulation kit cost {v3}.", "decision", "insulation cost",
             "How much did the insulation kit cost?"),
            ("The bed platform is {v4} centimeters long.", "decision", "bed platform length",
             "How long is the bed platform?"),
        ],
        "variants": {
            "v1": ["1,100", "1,300", "900", "1,200", "1,400", "1,000"],
            "v2": ["mid-April", "late March", "early May", "mid-May", "late April", "early April"],
            "v3": ["$240", "$260", "$220", "$280", "$250", "$230"],
            "v4": ["190", "185", "195", "200", "180", "188"],
        },
        "event_facts": [
            ("history", "insulation done", "Floor and insulation installation is complete."),
            ("history", "load math", "Daily electrical load is about 900 watt-hours with 25% headroom."),
            ("history", "battery choice", "The build uses AGM batteries, not lithium, until wiring is trusted."),
            ("history", "aisle check", "The aisle width was checked with the bed platform in place."),
            ("history", "wire labeling", "Every wiring run is labeled at both ends."),
            ("history", "curtain choice", "Curtains were chosen over a solid bulkhead for the cab."),
        ],
        "wrap": "Van build note — {fact}",
    },
]

EVENT_LINES = {
    "kitchen-remodel": [
        ("User", "The demo crew actually finished ahead of schedule."),
        ("Assistant", "Nice — that gives the tile crew some slack."),
        ("User", "Cabinets arrive Thursday, so the installer is next."),
        ("Assistant", "Confirm the countertop template date before install day."),
        ("User", "Painter gets booked once the drywall cures."),
        ("Assistant", "A few days of cure time protects the finish."),
        ("User", "Small fixtures come last — handles, faucet, lighting."),
        ("Assistant", "Right, they never block the big surfaces."),
    ],
    "dev-certification": [
        ("User", "My lab teardown script wipes everything nightly now."),
        ("Assistant", "Good hygiene — no surprise cloud bills."),
        ("User", "Finished the first full practice test."),
        ("Assistant", "Note the score and drill the two lowest domains."),
        ("User", "Networking is by far my weakest area."),
        ("Assistant", "Then weight the middle weeks toward networking scenarios."),
        ("User", "I'll keep the final week notes-only."),
        ("Assistant", "Consistency beats intensity — same slot every day."),
    ],
    "wedding-toast": [
        ("User", "The toast opens with the purple garage story."),
        ("Assistant", "Vivid and self-deprecating — good opener."),
        ("User", "I cut the second anecdote entirely."),
        ("Assistant", "One story is enough; keep the pacing tight."),
        ("User", "Rehearsing standing up with a timer."),
        ("Assistant", "Out loud — pacing on paper lies."),
        ("User", "Closing line lands on the couple, then the glass raise."),
        ("Assistant", "One sincere sentence, then done."),
    ],
    "salon-launch": [
        ("User", "Insurance is quoted and the lease is signed."),
        ("Assistant", "Licenses and insurance first — you're on sequence."),
        ("User", "Senior stylist signed yesterday."),
        ("Assistant", "They anchor quality and can mentor juniors later."),
        ("User", "Backbar order goes in before retail shelves."),
        ("Assistant", "Retail can wait until after opening week."),
        ("User", "Check-in dry run found two hiccups, both fixed."),
        ("Assistant", "Freeze the task list ten days out."),
    ],
    "van-conversion": [
        ("User", "Floor and insulation are done."),
        ("Assistant", "Next is electrical rough-in, then furniture modules."),
        ("User", "Daily load is about 900 watt-hours."),
        ("Assistant", "Size the battery with 25% headroom over that."),
        ("User", "Aisle width checks out with the bed in place."),
        ("Assistant", "Label both ends of every wiring run."),
        ("User", "Going with curtains over a bulkhead."),
        ("Assistant", "Cheaper, removable, and keeps the headroom."),
    ],
}

def make_session(idx):
    s = SCENARIOS[idx % len(SCENARIOS)]
    rep = idx // len(SCENARIOS)
    bridge, qa = [], []
    for tmpl, ftype, title, question in s["bridge"]:
        text = tmpl
        marker = None
        for vkey in sorted(s["variants"].keys()):
            if "{%s}" % vkey in text:
                val = s["variants"][vkey][rep]
                text = text.replace("{%s}" % vkey, val)
                marker = val
        bridge.append({"type": ftype, "title": title, "content": text, "marker": marker})
        qa.append({"question": question, "ground_truth": text, "marker": marker, "fact_type": ftype})

    events = [({"type": t, "title": title, "content": content}) for t, title, content in s["event_facts"]]
    raw_entries = bridge + events

    # 对话转写:事件对话 + 桥接事实散布为用户自述行(蒸馏与 Z0 同源)
    lines = list(EVENT_LINES[s["name"]])
    for j, b in enumerate(bridge):
        spoken = s["wrap"].format(fact=lower_first(b["content"]))
        lines.insert(3 + j * 3, ("User", spoken))
        lines.insert(4 + j * 3, ("Assistant", "Got it, noted."))
    transcript = "\n\n".join(f"{r}: {t}" for r, t in lines)

    return {"idx": str(idx), "scenario": s["name"], "repeat": rep,
            "transcript": transcript, "raw_entries": raw_entries, "qa": qa}

def lower_first(s):
    return s[0].lower() + s[1:]

rows = [make_session(i) for i in range(30)]
with open("data/edgemem_sessions.jsonl", "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

n_qa = sum(len(r["qa"]) for r in rows)
nomk = [r["idx"] for r in rows if any(q["marker"] is None for q in r["qa"])]
tlen = [len(r["transcript"]) for r in rows]
print(f"会话 {len(rows)}; QA {n_qa}; raw entries/会话 {len(rows[0]['raw_entries'])}; "
      f"transcript min/med/max = {min(tlen)}/{sorted(tlen)[len(tlen)//2]}/{max(tlen)}; marker 缺失: {nomk or '无'}")
