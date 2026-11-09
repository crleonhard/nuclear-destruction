# Nuclear Destruction: rules and rulings

This is the single written source for how the game behaves. Part 1 summarizes the original rules. Part 2
records every decision made where those rules were unclear or silent. Part 3 lists assumptions that were
made without being asked, so they can be challenged. Numbers in parentheses (#4) refer to the original list
of ambiguities. Where a ruling replaced an earlier one, only the current one is stated.

## 1. The game

**Goal:** destroy every other player's population while keeping at least 1 million of your own alive.

**Players and minors.** 3 to 9 players, each a country: BRAZIL, CHINA, ENGLAND, FRANCE, GERMANY, INDIA, JAPAN,
RUSSIA, USA. There are always 18 minor countries at the start: AUSTRALIA, BELGIUM, CUBA, DENMARK, ESTONIA,
FINLAND, GUATEMALA, HUNGARY, ICELAND, JORDAN, LEBANON, MONGOLIA, NORWAY, PANAMA, RWANDA, SYRIA, TOGO, URUGUAY.

| | Player | Minor |
|---|---|---|
| Population | 25-99M (set by the creator, or random) | 20M |
| Cash | $100M, +$5M each normal turn | none (collects gifts) |
| Factories | 9 | 1 |
| Missiles | 20 | 5 |
| ABMs | 10 | none |
| Popularity index | | one per player, starts at 0 |

All quantities are whole numbers. Factories are tracked in thirds (a whole factory is 3 thirds).

**Controlling a minor.** The player with the strictly highest index in a minor controls it and decides where
its missiles fire in battle. If the top index is tied (including everyone at 0), nobody controls it and it
fires nothing. Indices only ever go up: +1 per $1M given, +10 per missile given.

### A normal turn

Each player submits one sheet. Everything happens at once when the turn resolves.

**Required decisions**
- **Build.** Each whole factory builds one missile, one ABM, or one third of a factory. At most
  `ceil(whole factories / 2)` factories may build ABMs. Factories you do not assign build missiles. You build
  with the factories you had at the start of the turn.
- **Spies.** Three slots. At most one spy on a player; the rest go to minors. A spy on a player reports their
  missiles and ABMs; a spy on a minor reports every player's index there. A blank slot repeats its last target.

**Optional actions**
- Give cash to minors (only cash held at the start of the turn). "Give to every minor" is all or nothing.
- Give missiles to minors, including missiles built this turn. ABMs are never given or sold.
- Give cash, missiles, or factories to other players: at most 2 factories to one player, none to minors.
- Offer one factory for sale to the minors (see the auction below).
- Send diplomatic messages: at most one to each other living player, 500 characters, may be anonymous.
- Submit one world news item, 60 characters, may be anonymous.
- Declare war (not on turn 1, and only once per game; several players may declare on the same turn).

**Start of each normal turn (after the first):** a player with less than one whole factory gets a free third,
then everyone receives $5M income.

**The factory auction.** Minors bid all the cash they have been given. If `k` factories are offered, they all
sell at one price: the highest whole-dollar price `p` (at least $1) at which the minors' combined cash can buy
all `k`. If they cannot afford all `k` at $1 each, none sell. Factories are then allocated one at a time to the
minor with the most cash remaining (after paying `p` for earlier purchases); ties are broken by a seeded random
draw. Each buyer pays `p` per factory out of its cash and gains the factory; each seller receives `p`.

### A battle turn

Once war is declared, the next turn is a battle turn, then normal, battle, and so on.
- Each player fires missiles from their home country and from every minor they control, at any living country.
- All fire resolves simultaneously. For each target, incoming missiles minus its ABMs is the number that get
  through. Only ABMs that actually intercept are used up; spare ABMs are kept. Every fired missile is spent.
- Each missile that gets through costs a player 1M population and one third of a factory; a minor loses
  population only, and is destroyed (with everything it held) at 0.
- On the first battle turn each war declarer gets 5 bonus missiles that must be fired that turn or are lost,
  and must fire at least one missile from home. If they fire none, one bonus missile is fired at themselves
  (and ABMs can stop it). Nobody else is required to fire.
- No building, spying, giving or selling on battle turns; only messages and news.
- A player below 1M population is eliminated, but still fires on the turn they are eliminated.
- If every minor is destroyed, five new ones appear. They reuse the starting names with a generation suffix
  (CUBA becomes CUBA (II), identified as `CUBA#2`), start at full strength, and every index starts at 0.

**Ending.** The last living player wins. If every remaining player is eliminated on the same turn, nobody wins.

## 2. Rulings

### Information and spies
- **Spy reports show the end of the turn**, after that turn's builds and gifts (#11, #12). A spy on a player
  does not show the +5 war bonus, which is added when the battle turn opens.
- **Blank spy slots** repeat their last target; a slot that has never been sent anywhere does nothing, and
  nothing is sent on turn 1 (#10). If repeating a slot would put two spies on players, the sheet is rejected
  exactly as if both had been chosen explicitly.
- **The "first or second" list** uses end-of-turn indices, ignores any minor where your index is 0, and uses
  competition ranking, so ties share a rank and the next rank is skipped (1, 1, 3) (#13, #14).
- **Indices never decrease** (#4).

### Building and factories
- **Over-assigning factories rejects the whole sheet**; nothing is trimmed (#6).
- **The ABM cap uses whole factories only**: `ceil(whole factories / 2)`, fractions ignored (#7).
- **Factory fractions accumulate** across turns: each factory assigned to building factories adds one third (#8).
- **A factory sold or given away still builds for its seller that turn**; the new owner can use it from the
  next turn (#9).
- **The free third** arrives at the start of the next normal turn, not the turn the shortfall happens (#8).
- **Minors build missiles every normal turn**, including during war, never on battle turns (#19).

### Gifts and limits
- **Missile gifts to players may use missiles built this turn**, same as gifts to minors (#23).
- **A factory cannot be both given and offered**; given plus offered cannot exceed your whole factories (#22).
- **"Give to every minor"** costs the amount times the number of surviving minors and counts against your cash
  with your other gifts (#21).
- **Messages:** one per other player per turn, 500 characters, only to living players. The sender is set by the
  server; only the text can lie. Anonymous messages hide the sender from the recipient (#24).

### The auction
- Uniform price, all or nothing; no seller minimum (#15, #18). Winners pay out of their cash, which lowers their
  future bids (#17). Allocation is largest-remaining-cash first with seeded random tie-breaks.

### War
- Missiles built on the declaration turn can be fired on the next battle turn (#25).
- A source cannot fire more than it holds; over-firing rejects the sheet (#26).
- Control of minors is fixed at the start of each battle turn from the current indices (#27).
- Every fired missile is spent, intercepted or not (#30). Fire is simultaneous, so a country destroyed this
  turn still fires this turn (#31, #35).
- A damaged minor keeps its factories and missiles until it reaches 0 population (#32).
- Damage to a player's factories never goes below 0 (#33).
- **Eliminated players** lose all assets, cannot act or be targeted, receive no messages, and are ignored
  when working out who controls a minor (#34).
- **The self-hit** is paid from the 5 bonus missiles, never from the real stockpile, and ABMs apply to it (#28).
- **Only ABMs that intercept are consumed** (#29). Bonus missiles fire from home at any player or minor (#37).

### Game setup and flow
- **The creator sets each player's starting population**, or leaves it random (25-99) (#1).
- **Country choice:** players pick their country on joining, first come first served; anyone who has not
  chosen when the game starts is assigned a random remaining country.
- **The server is the only moderator** and does every moderator task automatically (#5).
- **Missed turns** (#38, #39): a missing player's factories all build missiles, their spies repeat, and they do
  nothing else; on a battle turn they fire nothing. A saved draft counts as submitted at the deadline. After N
  consecutive missed turns (default 5, 0 = never) the player is forfeited and treated as eliminated.
- **Hidden information** (#40-#42): each player sees only their own package. Orders stay hidden until the turn
  resolves and can be changed until the deadline. The turn resolves as soon as everyone has submitted a final
  sheet, or when the deadline passes. The only chance in the game is the auction tie-break, drawn from a seed
  that is kept secret until the game ends so that the whole game can be replayed exactly.

### Game limits and cancelling
- **A person can have only a few unfinished games they created at once** (3 by default; a deployment can change it or switch it off).
  Games in the lobby and games in progress count. Finished games do not, and neither do games the person only joined.
- **The creator can cancel a game that is still in its lobby.** The game, every seat and any AI players are removed, and a place is freed.
  A game that has started cannot be cancelled: it ends by being played, or by players forfeiting.

### AI players
- **Any seat can be an AI.** The creator can seat up to 8 AI players when creating a game, and add or remove them in the lobby
  (never after the game starts). They count towards the 3 to 9 players, take a random free country like any player who has not
  chosen one, and the creator can set their starting population like anyone's.
- **An AI follows every rule a person does.** It uses the same sheet, the same limits and the same validation, and its orders stay
  hidden until the turn resolves. It sees only what a person in its seat sees (its own assets, last turn's reports, the battle result,
  and the public table of countries and minors). Who is an AI, and its play style, is public.
- **An AI never misses a turn,** so it is never forfeited. It sends no messages or news, and gives nothing to other players.
- **AI players move at once.** They submit as soon as a turn opens, so the turn resolves early as soon as every person has submitted.
  When no living person is left (they were eliminated or forfeited), nobody remains to wait for: the server plays out all the
  remaining turns at once, without waiting for any turn deadline, until the game ends. As a safety net against a game that never
  ends, one pass plays at most 1,000 turns; if that is ever reached the game waits for the next deadline and carries on from there.
- **Play styles:** Hawk (builds fast, declares war early, fires everything), Diplomat (grows first, courts many minors, defends
  heavily, strikes late), Opportunist (balanced; waits until it looks at least as strong as the rivals it has spied on).

## 3. Assumptions made without being asked

These follow from how the game was built and can be changed:
- **No income on turn 1.** Players start turn 1 with exactly $100M; the $5M income begins on turn 2.
- **Resolution order within a normal turn:** builds, gifts, auction, minor builds, war declarations, forfeits,
  then reports. The database always holds the state as it is when a turn opens (income and bonuses already added).
- **New minors appear at the end of the battle turn** in which the last one is destroyed, and only if the game
  is not over.
- **Missiles may be fired at any living country,** including your own home country or minors you control.
- **A draft only saves if it is valid.** An invalid sheet is rejected with every problem listed, not stored.
- **A forfeit takes effect after the missed turn resolves**, so that turn still plays out with default orders.
- **Lobby limits:** the creator joins automatically and cannot leave; a turn lasts 1-168 hours (default 24).
- **AI strength was not specified.** The AI plays sensibly and legally but is not an expert; its styles are meant to give varied, plausible
  opponents. They are tunable numbers in `src/ai/personas.js`.
- **A diplomacy convenience:** the sheet editor may offer "send the same text to everyone", which fills one
  message per other living player. It changes no rule.
