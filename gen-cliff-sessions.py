r"""E8 压缩悬崖造会话器(确定性,零 LLM)。

设计(plan 2026-09-30, v2):
- 40 会话 = 5 场景 × 8 个 marker 变体。**变体是必须的**:温度 0 下同文重跑 ≈ 同一测量,
  marker 必须逐变体不同才是独立样本。
- 每会话 4 条带标记约束(具体数字/专名,不可猜)+ 12-16 轮情景对话 + 4 条巩固阶段诱饵。
- 约束句自然嵌入对话;marker 是保真度锚:机械口径 = marker 是否出现在蒸馏产物;
  judge 口径 = 3-class(faithful/distorted/dropped)。
- 会话形态对齐 summarize.js collectMessages 的视野:只有用户 prompt 与助手公开回复。
  ~2.5-4k 字符(低于 distillMaxChars 24000,不触发窗口截断)。

用法: python gen-cliff-sessions.py(写 data/cliff_sessions.jsonl)
输出行:{idx, scenario, repeat, transcript, constraints:[{text, marker, type_hint}], decoys:[...]}
"""
import json
import random

rng = random.Random(280741)

# 约束模板的 {vN} 占位符逐 repeat 取变体;每场景 8 套值。
SCENARIOS = [
    {
        "name": "kitchen-remodel",
        "constraints": [
            ("The total remodeling budget is exactly {v1} and I don't want to hear about going over.", "constraint"),
            ("All cabinet hardware must be brushed brass — I will return anything else.", "preference", "brushed brass"),
            ("No work crews in the house before {v2}, my newborn sleeps mornings.", "constraint"),
            ("The backsplash has to be the exact tile I picked: {v3} gloss.", "preference"),
        ],
        "variants": {
            "v1": ["$12,400", "$9,700", "$14,250", "$11,150", "$15,800", "$8,900", "$13,600", "$10,450"],
            "v2": ["9:30am", "8:45am", "10:15am", "9:00am", "10:00am", "8:30am", "9:45am", "10:30am"],
            "v3": ["Cascade Verde 4x8", "Slate Field 3x6", "Terracotta Wave 4x4", "Nordic Grey 6x6", "Olive Rustic 4x8", "Bone Matte 3x6", "Clay Ember 4x4", "Fog Laurel 6x6"],
        },
        "events": [
            ("User", "We're finally redoing the kitchen. Can you help me think through the sequence of steps?"),
            ("Assistant", "A typical sequence: design and order long-lead items, demolition, rough plumbing and electrical, drywall and paint, flooring, cabinets, then countertops and finishes."),
            ("User", "What should I pick first so I don't hold up the contractors?"),
            ("Assistant", "Cabinets and countertops are the long-lead items — choose those first, since appliances and tile usually coordinate around them."),
            ("User", "Makes sense. I'll measure the space this weekend and lock the tile and cabinet order."),
            ("Assistant", "Good plan. Also gather three contractor quotes before demolition so the timeline doesn't slip."),
            ("User", "The demo crew finished early; cabinets arrive Thursday."),
            ("Assistant", "Confirm the countertop template date now so install day goes smoothly."),
            ("User", "Template is booked. I still owe the painter a scheduling call."),
            ("Assistant", "Once paint cures a few days, the cabinet installer can work without risking the finish."),
            ("User", "What order for the small stuff — handles, faucet, lighting?"),
            ("Assistant", "Last, after the big surfaces are set; small fixtures are quick wins that never block anyone."),
            ("User", "Understood. I'll keep a punch list for the final walk-through."),
            ("Assistant", "Perfect — walk the room with the installer and note every gap before final payment."),
        ],
    },
    {
        "name": "dev-certification",
        "constraints": [
            ("I study exactly {v1} on weekday mornings before work — no more, I burn out.", "preference"),
            ("The exam fee comes out of a {v2} annual learning budget, so no paid courses beyond that.", "constraint"),
            ("I only use {v3} on my laptop, any instructions must be Linux-first.", "preference"),
            ("No study groups or Discord servers — I learn alone, period.", "preference", "alone"),
        ],
        "variants": {
            "v1": ["45 minutes", "30 minutes", "50 minutes", "40 minutes", "35 minutes", "55 minutes", "25 minutes", "60 minutes"],
            "v2": ["$300", "$450", "$260", "$380", "$520", "$290", "$410", "$340"],
            "v3": ["Ubuntu", "Debian", "Fedora", "Ubuntu LTS", "Pop!_OS", "Mint", "Arch", "openSUSE"],
        },
        "events": [
            ("User", "I want to pass the cloud developer certification in three months. Help me draft a study plan."),
            ("Assistant", "Three months is comfortable: weeks 1-4 core services, weeks 5-8 security and networking, weeks 9-12 practice exams and review."),
            ("User", "What's the best way to practice hands-on without racking up cloud bills?"),
            ("Assistant", "Use the free tier plus local emulators where possible, and tear down resources at the end of each session."),
            ("User", "Okay, I set up a lab script that wipes everything nightly."),
            ("Assistant", "Right hygiene. Track your weak areas per domain and revisit them weekly."),
            ("User", "Finished my first full practice test today."),
            ("Assistant", "Note the score, then drill the two lowest domains before the next mock."),
            ("User", "Networking is still my weakest area by far."),
            ("Assistant", "Then weight weeks 5-8 toward networking scenarios and re-test after."),
            ("User", "How do I keep the last three weeks from becoming pure panic?"),
            ("Assistant", "Front-load two full mocks in week 9; the final week is review of notes only, no new material."),
            ("User", "Sounds workable. I'll block the calendar slots now."),
            ("Assistant", "Consistency beats intensity — same slot every day builds the habit you need."),
        ],
    },
    {
        "name": "wedding-toast",
        "constraints": [
            ("My toast must be {v1} or I will ramble — hold me to it.", "constraint"),
            ("Absolutely no mention of the {v2}, the couple made me promise.", "constraint"),
            ("The wedding is strictly no-phones during ceremonies, so don't suggest livestreams.", "constraint", "no-phones"),
            ("I'm paying my share of the group gift: exactly {v3}.", "constraint"),
        ],
        "variants": {
            "v1": ["under three minutes", "under 90 seconds", "under two minutes", "under 150 seconds", "under 100 seconds", "under four minutes", "under two and a half minutes", "under 75 seconds"],
            "v2": ["Cancun incident", "Vegas bachelor party", "karaoke machine night", "Thanksgiving gravy debate", "go-kart crash", "campfire fireworks fail", "hilton pool fiasco", "cousin's roast"],
            "v3": ["$185", "$240", "$130", "$210", "$165", "$275", "$150", "$195"],
        },
        "events": [
            ("User", "I'm the best man at my brother's wedding next month and I'm terrified of the toast."),
            ("Assistant", "Build it in three beats: a short opening anecdote, what you admire about the couple, and a clean closing wish."),
            ("User", "I have a childhood story about him painting the garage purple."),
            ("Assistant", "Great opening — vivid, brief, and self-deprecating rather than embarrassing."),
            ("User", "Draft one is done. Read it and tell me if it drags."),
            ("Assistant", "Cut the second anecdote and keep the purple garage as the only story."),
            ("User", "Trimmed it. I'll rehearse with a timer this week."),
            ("Assistant", "Rehearse standing up and out loud — pacing on paper lies."),
            ("User", "Timed run felt good. What about the closing line?"),
            ("Assistant", "End on the couple, not on you; one sentence, sincere, then raise the glass."),
            ("User", "Should I thank the hosts formally first?"),
            ("Assistant", "One brief thanks is enough; the toast is a story, not an agenda."),
            ("User", "I'll do a final pass tomorrow with fresh eyes."),
            ("Assistant", "Then stop editing — a locked toast beats a polished draft you never finish."),
        ],
    },
    {
        "name": "salon-launch",
        "constraints": [
            ("Opening inventory cannot exceed {v1} before the soft opening.", "constraint"),
            ("We are closed {v2} — schedule everything around that.", "constraint"),
            ("Every product line must be cruelty-free certified, no exceptions for big brands.", "preference", "cruelty-free"),
            ("The front desk tablet must be an iPad, my booking software only runs there.", "constraint", "iPad"),
        ],
        "variants": {
            "v1": ["$6,200", "$4,800", "$7,500", "$5,400", "$8,100", "$5,900", "$6,800", "$4,500"],
            "v2": ["Sundays and Mondays", "Mondays and Tuesdays", "Sundays only", "Mondays only", "Tuesdays and Wednesdays", "Sundays and Tuesdays", "Mondays and Wednesdays", "Wednesdays only"],
            "v3": None,
        },
        "events": [
            ("User", "My salon soft-opens in six weeks. Help me sequence the launch tasks."),
            ("Assistant", "Sequence: licenses and insurance, buildout and equipment, staffing, inventory, then marketing two weeks out."),
            ("User", "Insurance is quoted, lease is signed. What about staff?"),
            ("Assistant", "Hire one senior stylist first — they anchor quality and can mentor juniors later."),
            ("User", "Signed a senior stylist yesterday. Now the product room."),
            ("Assistant", "Order backbar essentials first; retail shelves can wait until after opening week."),
            ("User", "The booking software finally synced to the front desk."),
            ("Assistant", "Test the full check-in flow with a friend before the soft opening."),
            ("User", "Ran a dry run with my cousin — two hiccups, both fixed."),
            ("Assistant", "You're on track. Freeze the task list ten days out and stop adding scope."),
            ("User", "When should I start the Instagram page?"),
            ("Assistant", "Two weeks out with three posts ready, then one post per week after opening."),
            ("User", "Pricing sheet is the last big unknown."),
            ("Assistant", "Benchmark three local salons, then set yours slightly under the midpoint for launch."),
        ],
    },
    {
        "name": "van-conversion",
        "constraints": [
            ("The van must sleep two adults {v1} — no compromise on bed length.", "constraint"),
            ("Total conversion budget is {v2} including tools.", "constraint"),
            ("I refuse lithium batteries for now; AGM only until I trust the wiring.", "preference", "AGM"),
            ("No roof cuts — no vents or racks that penetrate the roof skin.", "constraint", "No roof cuts"),
        ],
        "variants": {
            "v1": ["six feet tall", "six foot two", "five foot eleven", "six foot four", "five foot ten", "six foot six", "six foot one", "five foot nine"],
            "v2": ["$9,800", "$7,400", "$12,300", "$8,600", "$11,000", "$6,900", "$10,400", "$7,800"],
            "v3": None,
        },
        "events": [
            ("User", "I bought a cargo van and want to convert it for weekend trips over this spring."),
            ("Assistant", "Start with floor and insulation, then electrical rough-in, then furniture modules, then finishes."),
            ("User", "Insulation is in. How should I plan the electrical loads?"),
            ("Assistant", "List every device with watts and hours, sum daily watt-hours, then size battery and charging with 25% headroom."),
            ("User", "Did the math: about 900 watt-hours a day for my needs."),
            ("Assistant", "Then a pair of 6V AGMs in series gives comfortable capacity for that draw."),
            ("User", "Bed platform frame is bolted in this weekend."),
            ("Assistant", "Check the aisle width with the bed in place before you commit to cabinet depth."),
            ("User", "Aisle is fine. Wiring next weekend."),
            ("Assistant", "Label both ends of every run — future-you will thank present-you."),
            ("User", "How do I keep the build from smelling like glue forever?"),
            ("Assistant", "Water-based adhesives and a fan-through purge for two days after each big glue session."),
            ("User", "Curtains or a solid bulkhead for the cab?"),
            ("Assistant", "Curtains: cheaper, removable, and they don't eat your headroom."),
        ],
    },
]

FILLER_TURNS = [
    ("User", "By the way, my sister might visit that week, but no promises yet."),
    ("User", "I also want to keep the receipts organized this time."),
    ("Assistant", "Noted — a single envelope or folder per project keeps receipts findable."),
    ("User", "Okay, good to know. Anything else I should watch out for?"),
    ("Assistant", "Don't over-order up front; buy the first batch and adjust after a week of use."),
    ("User", "That matches what happened last time, honestly."),
    ("Assistant", "Then you already know the failure mode — plan around it once and move on."),
]

def make_session(idx):
    s = SCENARIOS[idx % len(SCENARIOS)]
    rep = idx // len(SCENARIOS)          # 0..7
    constraints = []
    vi = 0
    for c in s["constraints"]:
        text_tmpl, type_hint = c[0], c[1]
        marker = None
        text = text_tmpl
        if "{v1}" in text or "{v2}" in text or "{v3}" in text:
            for vkey in sorted(s["variants"].keys()):
                if "{%s}" % vkey in text:
                    val = s["variants"][vkey][rep]
                    text = text.replace("{%s}" % vkey, val)
                    marker = val
        else:
            # 静态约束:marker 在模板第 3 元显式给出
            marker = c[2] if len(c) > 2 else None
        vi += 1
        constraints.append({"text": text, "marker": marker, "type_hint": type_hint})

    lines = list(s["events"])
    # 注入约束行:散布在中段(时序不乱,只插入)
    for j, c in enumerate(constraints[:2]):
        lines.insert(3 + j * 4, ("User", "One more thing I should write down: " + c["text"]))
    for j, c in enumerate(constraints[2:]):
        lines.insert(6 + j * 5, ("User", "Before I forget — " + lower_first(c["text"])))
    # 收尾加 1-2 轮填充
    for i in range(rng.choice([1, 2])):
        ft = FILLER_TURNS[(idx + i) % len(FILLER_TURNS)]
        if ft not in lines:
            lines.append(ft)
    transcript = "\n\n".join(f"{r}: {t}" for r, t in lines)

    decoys = [
        {"type": "history", "title": f"{s['name']} step logged", "content": f"Worked on the {s['name']} plan; updated the checklist and moved one task forward."},
        {"type": "history", "title": f"{s['name']} step logged (copy)", "content": f"Worked on the {s['name']} planning checklist; advanced a task and noted the date."},
        {"type": "history", "title": f"{s['name']} old plan", "content": f"The {s['name']} plan from last season: three phases, generic vendor list, now superseded by newer notes."},
        {"type": "preference", "title": f"{s['name']} scheduling", "content": "The user likes doing planning work on weekend afternoons."},
    ]
    return {"idx": str(idx), "scenario": s["name"], "repeat": rep, "transcript": transcript,
            "constraints": constraints, "decoys": decoys}

def lower_first(s):
    return s[0].lower() + s[1:]

rows = [make_session(i) for i in range(40)]
with open("data/cliff_sessions.jsonl", "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

sizes = [len(r["transcript"]) for r in rows]
n_c = sum(len(r["constraints"]) for r in rows)
nomk = [r["idx"] for r in rows if any(c["marker"] is None for c in r["constraints"])]
print(f"会话 {len(rows)}; 约束 {n_c} 条; transcript min/med/max = {min(sizes)}/{sorted(sizes)[len(sizes)//2]}/{max(sizes)}; marker 缺失: {nomk or '无'}")
