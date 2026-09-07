#!/usr/bin/env bash
# offchain-probe — is the team alive? Pulls every public, keyless signal of
# activity around a token from sources the dev sandbox cannot reach, and writes
# investigations/<LABEL>-offchain.md. Runs on the GitHub Actions runner.
#
#   tools/offchain-probe.sh LABEL MINT COINGECKO_ID X_HANDLE TELEGRAM SITE ROBLOX_GROUP
set -u
LABEL=${1:?}; MINT=${2:?}; CG=${3:-}; XH=${4:-}; TG=${5:-}; SITE=${6:-}; RBX=${7:-}
OUT="investigations/${LABEL}-offchain.md"; mkdir -p investigations
UA='Mozilla/5.0 (X11; Linux x86_64) offchain-probe/1.0'
get() { curl -sSL -m 30 -A "$UA" -H 'accept: application/json,text/html;q=0.9,*/*;q=0.8' "$1" 2>/dev/null; }
say() { printf '%s\n' "$@" >> "$OUT"; }
hr()  { say "" "## $1" ""; }
: > "$OUT"
say "# Off-chain activity probe: $LABEL" "" "Mint \`$MINT\` · generated $(date -u +'%Y-%m-%d %H:%MZ')" ""

# ---------------------------------------------------------------- pump.fun
hr "pump.fun"
C=$(get "https://frontend-api-v3.pump.fun/coins/$MINT")
if [ -n "$C" ] && echo "$C" | jq -e .mint >/dev/null 2>&1; then
  echo "$C" | jq -r '"- name: \(.name) (\(.symbol)) · created \((.created_timestamp/1000)|todate) · bonded: \(.complete) · replies: \(.reply_count) · last reply: \(if .last_reply then (.last_reply/1000|todate) else "n/a" end) · last trade: \(if .last_trade_timestamp then (.last_trade_timestamp/1000|todate) else "n/a" end)\n- live now: \(.is_currently_live // false) · twitter: \(.twitter // "-") · telegram: \(.telegram // "-") · website: \(.website // "-")\n- creator: \(.creator)"' >> "$OUT"
  CREATOR=$(echo "$C" | jq -r .creator)
  R=$(get "https://frontend-api-v3.pump.fun/replies/$MINT?limit=200&offset=0")
  if echo "$R" | jq -e '(.replies // .) | type == "array"' >/dev/null 2>&1 && [ "$(echo "$R" | jq -r '(.replies // .) | length')" != "0" ]; then
    say "" "Comment thread (last 200 replies):" ""
    echo "$R" | jq -r --arg c "$CREATOR" '(.replies // .) as $r | ($r|length) as $n | ($r|map(select(.user==$c))|length) as $dev | ($r|map(.timestamp/1000|todate|.[0:7])|group_by(.)|map({m:.[0],n:length})|map("\(.m): \(.n)")|join(", ")) as $bym | "- \($n) replies loaded · by the creator: \($dev) · by month: \($bym)"' >> "$OUT"
    echo "$R" | jq -r --arg c "$CREATOR" '(.replies // .) | map(select(.user==$c)) | sort_by(-.timestamp) | .[0:8][] | "  - CREATOR \(.timestamp/1000|todate): \(.text|gsub("\n";" ")|.[0:160])"' >> "$OUT"
    echo "$R" | jq -r '(.replies // .) | sort_by(-.timestamp) | .[0:6][] | "  - \(.timestamp/1000|todate) \(.user[0:4])…: \(.text|gsub("\n";" ")|.[0:120])"' >> "$OUT"
  else say "- replies endpoint unavailable"; fi
else say "- pump.fun coin API unavailable (HTTP block or Cloudflare)"; fi

# --------------------------------------------------------------- coingecko
if [ -n "$CG" ]; then
  hr "CoinGecko ($CG)"
  G=$(get "https://api.coingecko.com/api/v3/coins/$CG?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true")
  if echo "$G" | jq -e .id >/dev/null 2>&1; then
    echo "$G" | jq -r '"- last updated: \(.last_updated) · genesis: \(.genesis_date // "-") · categories: \((.categories // [])|join(", "))\n- market cap: $\(.market_data.market_cap.usd // 0|floor) · 24h vol: $\(.market_data.total_volume.usd // 0|floor) · ATH: \(.market_data.ath.usd) on \(.market_data.ath_date.usd|.[0:10]) · from ATH: \(.market_data.ath_change_percentage.usd|floor)%\n- links: homepage \((.links.homepage // [])|map(select(.!=""))|join(" ")) · twitter @\(.links.twitter_screen_name // "-") · telegram \(.links.telegram_channel_identifier // "-") · github \((.links.repos_url.github // [])|join(" ")) · chat \((.links.chat_url // [])|map(select(.!=""))|join(" "))\n- community: twitter followers \(.community_data.twitter_followers // "n/a") · telegram users \(.community_data.telegram_channel_user_count // "n/a") · reddit subs \(.community_data.reddit_subscribers // "n/a")\n- developer: forks \(.developer_data.forks // "n/a") · stars \(.developer_data.stars // "n/a") · commits (4w) \(.developer_data.commit_count_4_weeks // "n/a") · PRs merged \(.developer_data.pull_requests_merged // "n/a")\n- watchlist users: \(.watchlist_portfolio_users // "n/a") · sentiment up: \(.sentiment_votes_up_percentage // "n/a")%\n- description: \((.description.en // "")|gsub("\n";" ")|.[0:400])"' >> "$OUT"
  else say "- CoinGecko: not found / rate-limited"; fi
fi

# ------------------------------------------- discover socials from listings
D=$(get "https://api.dexscreener.com/tokens/v1/solana/$MINT")
GT=$(get "https://api.geckoterminal.com/api/v2/networks/solana/tokens/$MINT/info")
ALLURLS=$(printf '%s\n%s\n%s\n%s\n' "$C" "$G" "$D" "$GT" | grep -oE 'https?://[A-Za-z0-9./_?=&%+-]+' | sort -u)
TGS=$(printf '%s\n' "$ALLURLS" | grep -oiE 't\.me/(s/)?[A-Za-z0-9_]+' | sed -E 's#t\.me/(s/)?##' | sort -fu | tr '\n' ' ')
DISCORDS=$(printf '%s\n' "$ALLURLS" | grep -oiE '(discord\.gg|discord\.com/invite)/[A-Za-z0-9-]+' | sed -E 's#.*/##' | sort -u | tr '\n' ' ')
RBXS=$(printf '%s\n' "$ALLURLS" | grep -oiE 'roblox\.com/(communities|groups)/[0-9]+' | grep -oE '[0-9]+$' | sort -u | tr '\n' ' ')
SITES=$(printf '%s\n' "$ALLURLS" | grep -viE 'x\.com|twitter\.com|t\.me|discord|roblox\.com|pump\.fun|coingecko|dexscreener|geckoterminal|cdn\.|ipfs|arweave|\.(png|jpg|jpeg|gif|svg|webp)' | sed -E 's#https?://##; s#/.*##' | sort -u | tr '\n' ' ')
hr "Socials discovered from listings"
say "- telegram: ${TGS:-none} · discord invites: ${DISCORDS:-none} · roblox communities: ${RBXS:-none} · sites: ${SITES:-none}"
for H in $TGS; do case " $TG " in *" $H "*) ;; *) TG="$TG $H";; esac; done
for R in $RBXS; do case " $RBX " in *" $R "*) ;; *) RBX="$RBX $R";; esac; done
for W in $SITES; do case " $SITE " in *" $W "*) ;; *) SITE="$SITE $W";; esac; done

# ------------------------------------------------------------------ discord
for INV in $DISCORDS; do
  hr "Discord invite $INV"
  DI=$(get "https://discord.com/api/v10/invites/$INV?with_counts=true&with_expiration=true")
  echo "$DI" | jq -r 'if .guild then "- server: \(.guild.name) · members \(.approximate_member_count) · online now \(.approximate_presence_count) · channel #\(.channel.name // "?") · invite expires \(.expires_at // "never")" else "- invite invalid or expired (\(.message // "no response"))" end' >> "$OUT" 2>/dev/null || say "- discord API unavailable"
done

# --------------------------------------------------------- X (no login)
if [ -n "$XH" ]; then
  hr "X / Twitter @$XH"
  S=$(get "https://cdn.syndication.twimg.com/timeline/profile?screen_name=$XH")
  if [ -n "$S" ]; then
    DATES=$(echo "$S" | grep -oE 'datetime="[^"]+"|"created_at":"[^"]+"' | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}|[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{2} [0-9:]{8} \+0000 [0-9]{4}' | sort -u | tail -15 | tr '\n' ' ')
    say "- syndication timeline: ${#S} bytes; dates seen: ${DATES:-none}"
    echo "$S" | grep -oE '"full_text":"[^"]{0,200}' | head -8 | sed 's/^"full_text":"/  - /' >> "$OUT"
  else say "- syndication timeline unavailable"; fi
  for U in "x.com/$XH" "twitter.com/$XH"; do
    CDX=$(get "https://web.archive.org/cdx/search/cdx?url=$U&output=json&fl=timestamp&filter=statuscode:200&from=2025&collapse=timestamp:8&limit=60")
    N=$(echo "$CDX" | jq -r 'if type=="array" then (length-1) else 0 end' 2>/dev/null)
    LAST=$(echo "$CDX" | jq -r 'if type=="array" and length>1 then .[-1][0] else "" end' 2>/dev/null)
    say "- Wayback snapshots of $U since 2025: ${N:-0} · latest: ${LAST:-none}"
    if [ -n "$LAST" ]; then
      SNAP=$(get "https://web.archive.org/web/${LAST}id_/https://$U")
      TW=$(echo "$SNAP" | grep -oE 'datetime="[0-9]{4}-[0-9]{2}-[0-9]{2}' | sort -u | tail -12 | sed 's/datetime="//' | tr '\n' ' ')
      say "  - tweet dates visible in that snapshot: ${TW:-none (X renders client-side; archive may hold only the shell)}"
      FOLLOW=$(echo "$SNAP" | grep -oiE '[0-9.,]+[KM]? (Followers|Following)' | head -4 | tr '\n' ' ')
      [ -n "$FOLLOW" ] && say "  - counts in snapshot: $FOLLOW"
    fi
  done
fi

# ---------------------------------------------------------------- telegram
for TGH in $TG; do
  hr "Telegram $TGH"
  T=$(get "https://t.me/s/$TGH")
  if echo "$T" | grep -q 'tgme_widget_message'; then
    CNT=$(echo "$T" | grep -oE 'tgme_channel_info_counter[^<]*<span class="counter_value">[^<]+' | sed 's/.*>//' | head -3 | tr '\n' ' ')
    DATES=$(echo "$T" | grep -oE 'datetime="[0-9]{4}-[0-9]{2}-[0-9]{2}' | sed 's/datetime="//' | sort -u | tail -12 | tr '\n' ' ')
    say "- public channel preview: counters $CNT · last message dates: $DATES"
    echo "$T" | grep -oE 'tgme_widget_message_text[^>]*>[^<]{0,200}' | tail -5 | sed 's/^[^>]*>/  - /' >> "$OUT"
  else
    CNT=$(echo "$T" | grep -oE '[0-9 ]+(members|subscribers)' | head -1)
    say "- no public preview (private group or invite-only); page says: ${CNT:-nothing}"
  fi
done

# -------------------------------------------------------------------- site
for SITE in $SITE; do
  hr "Website $SITE"
  H=$(curl -sSL -m 30 -A "$UA" -o /tmp/site.html -w '%{http_code} %{url_effective} %{size_download}B' "https://$SITE/" 2>/dev/null)
  say "- fetch: $H"
  if [ -s /tmp/site.html ]; then
    TITLE=$(grep -oiE '<title>[^<]+' /tmp/site.html | head -1 | sed 's/<title>//')
    LM=$(curl -sSI -m 20 -A "$UA" "https://$SITE/" 2>/dev/null | grep -iE '^(last-modified|x-vercel|server|x-powered-by|cf-)' | tr -d '\r' | head -5 | tr '\n' ' ')
    say "- title: ${TITLE:-?} · headers: ${LM:-none}"
    say "- dates mentioned in page: $(grep -oE '20[2-9][0-9]-[01][0-9]-[0-3][0-9]|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* [0-9]{1,2},? 20[2-9][0-9]' /tmp/site.html | sort -u | tail -10 | tr '\n' ' ')"
    say "- outbound links: $(grep -oE 'href="https?://[^"]+' /tmp/site.html | sed 's/href="//' | grep -vE "$SITE" | sort -u | head -15 | tr '\n' ' ')"
    say "- scripts/bundles: $(grep -oE '(src|href)="[^"]+\.(js|json)' /tmp/site.html | sed 's/^[a-z]*="//' | head -6 | tr '\n' ' ')"
    say "- text sample: $(sed -e 's/<script[^>]*>.*<\/script>//g' -e 's/<[^>]*>/ /g' /tmp/site.html | tr -s ' \n' ' ' | cut -c1-700)"
    for P in sitemap.xml docs changelog blog api; do
      CODE=$(curl -s -o /dev/null -m 15 -A "$UA" -w '%{http_code}' "https://$SITE/$P" 2>/dev/null); say "  - /$P → $CODE"
    done
  fi
  CDX=$(get "https://web.archive.org/cdx/search/cdx?url=$SITE&output=json&fl=timestamp,digest&filter=statuscode:200&collapse=digest&limit=100")
  echo "$CDX" | jq -r 'if type=="array" and length>1 then "- Wayback: \(length-1) distinct versions · first \(.[1][0]) · latest changed \(.[-1][0])" else "- Wayback: no snapshots" end' >> "$OUT" 2>/dev/null
done

# ------------------------------------------------------------------ roblox
for RBX in $RBX; do
  hr "Roblox group $RBX"
  GR=$(get "https://groups.roblox.com/v1/groups/$RBX")
  echo "$GR" | jq -r '"- \(.name // "?") · members \(.memberCount // "?") · owner \(.owner.username // "?") · \((.description // "")|gsub("\n";" ")|.[0:200])"' >> "$OUT" 2>/dev/null || say "- group API unavailable"
  GM=$(get "https://games.roblox.com/v2/groups/$RBX/gamesV2?accessFilter=2&limit=50&sortOrder=Desc")
  echo "$GM" | jq -r '.data[]? | "  - game \(.name) · visits \(.placeVisits) · created \(.created|.[0:10]) · updated \(.updated|.[0:10])"' >> "$OUT" 2>/dev/null
  [ "$(echo "$GM" | jq -r '.data|length' 2>/dev/null)" = "0" ] && say "  - no public games under this group"
  GS=$(get "https://groups.roblox.com/v1/groups/$RBX/wall/posts?limit=10&sortOrder=Desc")
  echo "$GS" | jq -r '.data[]? | "  - wall post \(.created|.[0:10]) by \(.poster.user.username // "?"): \(.body|gsub("\n";" ")|.[0:100])"' >> "$OUT" 2>/dev/null
done
hr "Roblox Creator Store search"
for CAT in 5 10; do
  CS=$(get "https://apis.roblox.com/toolbox-service/v1/marketplace/$CAT?keyword=${LABEL}&limit=10")
  echo "$CS" | jq -r --arg c "$CAT" '.data[]? | "- category \($c): asset \(.id) \(.name // "") by \(.creator.name // "?") · updated \(.updated // "?")"' >> "$OUT" 2>/dev/null
done
say "$(grep -c 'category' "$OUT" | sed 's/^0$/- nothing named '"$LABEL"' in the Creator Store plugin or model categories/;s/^[1-9].*//')"

# --------------------------------------------------------- token info pages
hr "DexScreener / GeckoTerminal token info"
echo "$D" | jq -r '.[0] | "- dex: \(.dexId) · liquidity $\(.liquidity.usd|floor) · fdv $\(.fdv|floor) · 24h vol $\(.volume.h24|floor) · websites \((.info.websites // [])|map(.url)|join(" ")) · socials \((.info.socials // [])|map("\(.type):\(.url)")|join(" "))"' >> "$OUT" 2>/dev/null
echo "$GT" | jq -r '.data.attributes | "- GT score \(.gt_score) · holders \(.holders.count // "?") · categories \((.categories // [])|join(", ")) · discord \(.discord_url // "-") · telegram \(.telegram_handle // "-") · twitter \(.twitter_handle // "-") · websites \((.websites // [])|join(" "))\n- description: \((.description // "")|gsub("\n";" ")|.[0:300])"' >> "$OUT" 2>/dev/null

say "" "Method: every source is public and keyless; a missing section means the source blocked the runner. X is read via the syndication endpoint and Wayback snapshots, which show a subset of posts." ""
cat "$OUT"
