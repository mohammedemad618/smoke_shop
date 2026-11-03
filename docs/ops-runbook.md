# دليل تشغيل نقطة البيع على الخادم

> هذا الدليل يجهّز النظام متعدد المتاجر على خادمك الحالي (108.61.190.4) خطوة بخطوة، حسب القسم 7 والمرحلتين 5 و6 في `docs/multitenant-plan.md`. كل أمر يُنفَّذ كـ root عبر SSH ويُنسخ كما هو، وبالترتيب. الأوامر التي فيها كلمة مرور تنفّذها **أنت بنفسك** في جلسة SSH تفاعلية (الخطوة 9)، ولا تُكتب أي كلمة مرور في سطر أوامر أبدًا.

**ما يُضاف:** مستخدم `pos`، وخدمة `pos.service` على `127.0.0.1:3401`، وثلاثة مؤقتات (`pos-root-worker` كل دقيقة، `pos-backup` ليلًا، `pos-monitor` كل 5 دقائق)، وملف nginx جديد `sites-available/pos` ومقطع `snippets/pos-proxy.conf`، وملفا htpasswd، ومجلدات تبدأ أسماؤها بـ `pos`، وإعداد certbot مستقل في `/etc/letsencrypt-pos`.

**ما لا يُلمس:** ملفات niura وعامله وشهاداته، وتطبيقات pm2 الأخرى، وإعدادات `mongod` (تبقى بلا مصادقة)، و`/etc/letsencrypt`، و`hishin-backup`، ومواقع hishin وlapsa وsales-accounts وurgold. الإجراء الوحيد المشترك هو `systemctl reload nginx` بعد `nginx -t`، ومعه مقارنة بصمة كل المواقع الأخرى قبل التغيير وبعده. الاستثناء الوحيد في آخر الطريق: ملف موقع smoke القديم يُستبدل بتحويل (الخطوة 12)، ويُوقف تطبيق pm2 `smoke-shop` مع إبقائه للتراجع.

**البيانات:** بيانات نقطة البيع الحالية على الخادم تجريبية، ولا تُنقل إلى النظام الجديد. المتجر `smoke` يبدأ فارغًا.

---

## الملفات وأماكنها

| في المستودع | على الخادم | المالك والصلاحيات |
|---|---|---|
| `ops/sbin/pos-root-worker.mjs` | `/usr/local/sbin/pos-root-worker.mjs` | `root:root 0700` |
| `ops/sbin/pos-monitor.mjs` | `/usr/local/sbin/pos-monitor.mjs` | `root:root 0700` |
| `ops/sbin/pos-fingerprint.sh` | `/usr/local/sbin/pos-fingerprint` | `root:root 0700` |
| `ops/deploy.sh` | `/usr/local/sbin/pos-deploy` | `root:root 0700` |
| `ops/systemd/*.service` و`*.timer` | `/etc/systemd/system/` | `root:root 0644` |
| `ops/nginx/pos.conf` | `/etc/nginx/sites-available/pos` ورابط في `sites-enabled` | `root:root 0644` |
| `ops/nginx/pos-proxy.conf` | `/etc/nginx/snippets/pos-proxy.conf` | `root:root 0644` |
| `ops/nginx/smoke-shop-redirect.conf` | يحل محل `/etc/nginx/sites-available/smoke-shop` (الخطوة 12) | `root:root 0644` |
| `ops/pos.env.example` | `/etc/pos/pos.env` | `root:pos 0640` |

| المجلد | المالك والصلاحيات | الغرض |
|---|---|---|
| `/srv/pos` و`/srv/pos/releases` | `root:pos 0750` | الإصدارات (`releases/<sha>`) والرابط `current` |
| `/srv/pos/repo` | `root:root 0700` | نسخة git مجردة (bare) من GitHub |
| `/etc/pos` | `root:pos 0750` | ملف الإعدادات |
| `/var/lib/pos-spool` | `root:root 0755` | مجلد الطلبات بين التطبيق والعامل |
| `/var/lib/pos-spool/desired` و`retire` و`requests` | `root:pos 1730` | يكتب فيها التطبيق ولا يستطيع سردها |
| `/var/lib/pos-spool/state` و`certs` و`jobs` و`backups` | `root:root 0755` | يكتبها العامل فقط، ويقرؤها التطبيق |
| `/var/lib/pos-root-worker` | `root:root 0700` | حالة العامل الداخلية والقفل |
| `/var/backups/pos` | `root:root 0700` | النسخ الاحتياطية (الملفات 0600) |
| `/etc/letsencrypt-pos` و`/var/log/letsencrypt-pos` | `root:root 0755` | إعداد certbot وسجلاته الخاصة بنقطة البيع |
| `/var/lib/letsencrypt-pos` | `root:root 0700` | مجلد عمل certbot |
| `/etc/nginx/pos-certs` | `root:www-data 0750` | الشهادات كما يقرؤها nginx، مثل `niura-certs` |

---

## 1. الفحوص المسبقة (قراءة فقط)

لا يغيّر أي أمر هنا شيئًا. النتائج تُحفظ في ملف لتعود إليها:

```bash
{
  echo "== system"; date -u; nproc; free -m; swapon --show; df -h / /var/lib/mongodb /var/backups
  timedatectl | grep -E 'Time zone|synchronized'
  echo "== ports"; ss -ltnp
  echo "== user and folders"; getent passwd pos || echo "no user pos"
  ls -ld /srv/pos /etc/pos /var/lib/pos-spool /var/backups/pos /etc/nginx/pos-certs /etc/letsencrypt-pos 2>&1
  echo "== tools"; readlink -f "$(command -v node)"; node -v; npm -v
  command -v mongosh mongodump mongorestore certbot htpasswd openssl curl flock git
  mongodump --version | head -1; certbot --version; nginx -v
  echo "== nginx"; nginx -T 2>/dev/null > /root/nginx-T-before.txt; wc -l /root/nginx-T-before.txt
  grep -n 'pos_' /root/nginx-T-before.txt || echo "no pos_ names in nginx"
  grep -n 'pos\.108-61-190-4' /root/nginx-T-before.txt || echo "no pos.108-61-190-4 names in nginx"
  grep -nE '^\s*(server_name|listen)\s' /root/nginx-T-before.txt
  echo "== mongodb"; systemctl is-active mongod
  mongosh --quiet --eval 'db.adminCommand({listDatabases: 1, nameOnly: true}).databases.map((d) => d.name).join(" ")'
  mongosh --quiet --eval 'db.adminCommand({listDatabases: 1, nameOnly: true}).databases.filter((d) => d.name.startsWith("pos_")).length + " pos_ databases"'
  mongosh --quiet --eval 'try { rs.status().ok } catch (e) { e.codeName }'
  mongosh --quiet --eval 'const c = db.serverStatus().wiredTiger.cache; print("WT cache: " + Math.round(c["maximum bytes configured"] / 1048576) + " MB max, " + Math.round(c["bytes currently in the cache"] / 1048576) + " MB now")'
  grep -E 'open files|processes' /proc/$(pidof mongod)/limits
  grep -A4 -E '^(net|security|storage):' /etc/mongod.conf
  echo "== timers and certbot"; systemctl list-timers --all --no-pager
  systemctl cat hishin-backup.service niura-certs.service --no-pager
  cat /etc/letsencrypt/cli.ini; ls -l /etc/letsencrypt/renewal-hooks/*/
  grep -E '^(authenticator|webroot_path|installer)' /etc/letsencrypt/renewal/smoke.108-61-190-4.sslip.io.conf
  ls -ld /var/www/letsencrypt /etc/nginx/niura-certs; ls -l /etc/nginx/niura-certs | head
  echo "== firewall and pm2"; ufw status verbose; pm2 ls
} 2>&1 | tee /root/pos-preflight-$(date -u +%Y%m%d).txt
```

ثم اقرأ سكربت النسخ الخاص بـ hishin (السؤال 5 في الخطة): هل ينسخ `mongod` الرئيسي أم `mongod-hishin` فقط؟

```bash
cat /srv/hishin/backup.sh
```

**شروط المتابعة** (إن لم يتحقق أحدها فتوقف):
- لا توجد قاعدة تبدأ بـ `pos_` (`0 pos_ databases`)، ولا اسم `pos_` ولا `pos.108-61-190-4` في nginx.
- لا شيء يستمع على المنفذ 3401، ولا يوجد مستخدم `pos`، ولا أي مجلد من المجلدات أعلاه.
- `System clock synchronized: yes`.
- `rs.status()` يعطي `NoReplicationEnabled` (خادم مستقل، وهذا متوقع).
- **الهامش** = `MemAvailable` (من `free -m`، عمود available) − (أقصى ذاكرة WT − الحالية) − 150. يجب أن يكون 280 MB على الأقل، وهو حد `MemoryMax` لخدمتنا. إن كان أقل فخفّض `MemoryHigh` و`MemoryMax` في `pos.service` قبل الخطوة 7 وسجّل ذلك.
- `server_name` في أي موقع آخر لا ينتهي بـ `.pos.108-61-190-4.sslip.io`. (أسماء niura مثل `*.erp…` و`*.sites…` لا تتداخل مع أسمائنا، وعنوان المتاجر wildcard أطول من أي wildcard على `*.108-61-190-4.sslip.io` فيغلبه.)

---

## 2. المستخدم pos والمجلدات والصلاحيات

```bash
useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin pos
id pos

install -d -o root -g pos -m 0750 /srv/pos /srv/pos/releases /etc/pos
install -d -o root -g root -m 0755 /var/lib/pos-spool /var/lib/pos-spool/state \
  /var/lib/pos-spool/state/certs /var/lib/pos-spool/state/jobs /var/lib/pos-spool/state/backups
install -d -o root -g pos -m 1730 /var/lib/pos-spool/desired /var/lib/pos-spool/retire /var/lib/pos-spool/requests
install -d -o root -g root -m 0700 /var/lib/pos-root-worker /var/backups/pos /var/lib/letsencrypt-pos
install -d -o root -g root -m 0755 /etc/letsencrypt-pos /var/log/letsencrypt-pos
install -d -o root -g www-data -m 0750 /etc/nginx/pos-certs
```

تحقق من الصلاحيات:

```bash
stat -c '%a %U:%G %n' /srv/pos /srv/pos/releases /etc/pos /var/lib/pos-spool /var/lib/pos-spool/{desired,retire,requests,state} \
  /var/lib/pos-root-worker /var/backups/pos /etc/nginx/pos-certs
```

المتوقع: `750 root:pos` للثلاثة الأولى، `755 root:root` للـ spool وstate، `1730 root:pos` للمجلدات الثلاثة، `700 root:root` للعامل والنسخ، `750 root:www-data` لـ pos-certs.

وتحقق أن المستخدم `pos` يكتب في مجلد الطلبات ولا يسرده، ويقرأ الحالة، ولا يصل إلى النسخ:

```bash
runuser -u pos -- touch /var/lib/pos-spool/requests/perm-test && runuser -u pos -- rm /var/lib/pos-spool/requests/perm-test && echo "pos writes requests/: ok"
runuser -u pos -- ls /var/lib/pos-spool/requests    # المتوقع: Permission denied
runuser -u pos -- ls /var/lib/pos-spool/state       # المتوقع: certs jobs backups
runuser -u pos -- ls /var/backups/pos               # المتوقع: Permission denied
```

---

## 3. جلب الكود وتثبيت ملفات التشغيل

نسخة git مجردة من نفس المستودع الذي يُسحب منه الموقع اليوم (بنفس صلاحيات الوصول التي يستخدمها root):

```bash
git clone --bare "$(git -C /srv/smoke_shop remote get-url origin)" /srv/pos/repo
chmod 0700 /srv/pos/repo
git --git-dir=/srv/pos/repo fetch --prune --force origin '+refs/heads/*:refs/remotes/origin/*'
git --git-dir=/srv/pos/repo branch -r
```

اختر الفرع: `multitenant` الآن، أو `main` بعد دمجه. ثم استخرج ملفات التشغيل لمراجعتها:

```bash
REF=multitenant
SHA=$(git --git-dir=/srv/pos/repo rev-parse "refs/remotes/origin/$REF"); echo "$SHA"
rm -rf /root/pos-ops && install -d -m 0700 /root/pos-ops
git --git-dir=/srv/pos/repo archive "$SHA" ops docs/ops-runbook.md | tar -x -C /root/pos-ops --no-same-owner
find /root/pos-ops -type f | sort
```

راجع الملفات (`less /root/pos-ops/ops/sbin/pos-root-worker.mjs` وغيره). ثم شغّل اختبار العامل على الخادم نفسه: يعمل في مجلد مؤقت ببرامج وهمية بدل certbot وMongoDB، ولا يتصل بشيء. على Linux تعمل كل الاختبارات، ومنها تثبيت شهادة لـ nginx:

```bash
cd /root/pos-ops && node --test ops/test/worker.test.mjs; cd ~
```

المتوقع: `pass 15` و`fail 0` و`skipped 0`. ثم التثبيت:

```bash
cd /root/pos-ops/ops
install -o root -g root -m 0700 sbin/pos-root-worker.mjs /usr/local/sbin/pos-root-worker.mjs
install -o root -g root -m 0700 sbin/pos-monitor.mjs /usr/local/sbin/pos-monitor.mjs
install -o root -g root -m 0700 sbin/pos-fingerprint.sh /usr/local/sbin/pos-fingerprint
install -o root -g root -m 0700 deploy.sh /usr/local/sbin/pos-deploy
node --check /usr/local/sbin/pos-root-worker.mjs && node --check /usr/local/sbin/pos-monitor.mjs \
  && bash -n /usr/local/sbin/pos-deploy && bash -n /usr/local/sbin/pos-fingerprint && echo "scripts: ok"

install -o root -g root -m 0644 systemd/pos.service systemd/pos-root-worker.service systemd/pos-root-worker.timer \
  systemd/pos-backup.service systemd/pos-backup.timer systemd/pos-monitor.service systemd/pos-monitor.timer /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/pos.service /etc/systemd/system/pos-root-worker.service \
  /etc/systemd/system/pos-backup.service /etc/systemd/system/pos-monitor.service
cd ~
```

لا يُشغَّل أي شيء بعد. `systemd-analyze verify` لا يجب أن يطبع أخطاء (تحذير عن مجلد `/srv/pos/current` غير الموجود بعد مقبول).

mongosh الذي يستخدمه العامل يحفظ إعداداته في `/var/lib/pos-root-worker` (لا في `/root`). أوقف عنه إرسال بيانات الاستخدام مرة واحدة:

```bash
HOME=/var/lib/pos-root-worker mongosh --nodb --quiet --eval 'disableTelemetry()'
```

---

## 4. ملف الإعدادات pos.env

```bash
install -o root -g pos -m 0640 /root/pos-ops/ops/pos.env.example /etc/pos/pos.env
printf 'TOTP_KEY=%s\n' "$(openssl rand -hex 32)" >> /etc/pos/pos.env
nano /etc/pos/pos.env
```

في nano راجع القيم (المنفذ 3401، العناوين، `SPOOL_DIR=/var/lib/pos-spool`). المفتاح `TOTP_KEY` يُولَّد على الخادم ولا يظهر في سجل الأوامر. احفظ نسخة منه في مدير كلمات المرور عندك: بدونه لا يمكن قراءة رمز التحقق الخاص بالمسؤول بعد أي إعادة تثبيت.

```bash
stat -c '%a %U:%G' /etc/pos/pos.env     # المتوقع: 640 root:pos
grep -c '^TOTP_KEY=' /etc/pos/pos.env   # المتوقع: 1
```

بعد النشر الأول (الخطوة 7) قارن المتغيرات مع ما يتوقعه الإصدار، فأي متغير جديد في `.env.example` يُضاف هنا.

---

## 5. nginx: التثبيت والتحقق

**أولًا البصمة «قبل» وأرشيف nginx:**

```bash
install -d -m 0700 /root/backups
tar -czf /root/backups/nginx-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C / etc/nginx
pos-fingerprint > /root/pos-fp-before.txt; cat /root/pos-fp-before.txt
```

الملف فيه لكل موقع (hishin وapi.hishin وlapsa وsales وurgold وerp وغيرها، ومضيف من `*.erp` وآخر من `*.sites`): حالة HTTP على المنفذين 80 و443، وبصمة SHA-256 للشهادة. ثم `sha256sum` لكل ملفات nginx ما عدا ملفاتنا، ومنها ملفات niura.

**ثانيًا التثبيت:**

```bash
grep -rn 'pos_' /etc/nginx || echo "no pos_ names"
test ! -e /etc/nginx/sites-available/pos && test ! -e /etc/nginx/snippets/pos-proxy.conf && echo "names free"
install -o root -g root -m 0644 /root/pos-ops/ops/nginx/pos.conf /etc/nginx/sites-available/pos
install -o root -g root -m 0644 /root/pos-ops/ops/nginx/pos-proxy.conf /etc/nginx/snippets/pos-proxy.conf
# ملف كلمات مرور لوحة الإدارة، فارغ حتى الخطوة 9: الدخول مرفوض للجميع حتى ذلك الحين
install -o root -g www-data -m 0640 /dev/null /etc/nginx/.htpasswd-pos-admin
ln -s /etc/nginx/sites-available/pos /etc/nginx/sites-enabled/pos
nginx -t && systemctl reload nginx
```

إن فشل `nginx -t` فلا يُعاد تحميل شيء: احذف الرابط بـ `rm /etc/nginx/sites-enabled/pos` وأرسل لي الخطأ.

**ثالثًا البصمة «بعد»:**

```bash
pos-fingerprint > /root/pos-fp-after.txt
diff /root/pos-fp-before.txt /root/pos-fp-after.txt && echo "no change to any other site"
```

يجب ألا يظهر أي فرق. استثناء واحد ممكن: عامل niura يجدد شهادات شركاته وحده كل دقيقة، فإن تغيرت بصمة شهادة تحت `*.erp` أو `*.sites` أو ملف في `/etc/nginx/niura-certs` فقط، فانظر `journalctl -u niura-certs --since -10min` قبل أن تشك في تغييرنا. أي فرق غير ذلك في موقع آخر: تراجع فورًا:

```bash
rm /etc/nginx/sites-enabled/pos && nginx -t && systemctl reload nginx
```

**رابعًا عناويننا:**

```bash
curl -sS http://admin.pos.108-61-190-4.sslip.io/.well-known/acme-challenge/pos-probe
# المتوقع: pos-ok
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://smoke.pos.108-61-190-4.sslip.io/cashier.html
# المتوقع: 301 https://smoke.pos.108-61-190-4.sslip.io/cashier.html
timeout 10 openssl s_client -connect 127.0.0.1:443 -servername smoke.pos.108-61-190-4.sslip.io </dev/null 2>&1 | grep -E 'alert|Verify|subject' | head -3
# المتوقع: فشل المصافحة (لا شهادة بعد)، وليس شهادة niura أو موقع آخر
```

---

## 6. certbot: الحساب وتجربة staging

إعداد certbot لنقطة البيع مستقل تمامًا: مجلداته الثلاثة خاصة، فلا يمس `/etc/letsencrypt` ولا قفل niura ولا حدوده. لتسهيل الأوامر في هذه الجلسة:

```bash
cbpos() { certbot --config-dir /etc/letsencrypt-pos --work-dir /var/lib/letsencrypt-pos --logs-dir /var/log/letsencrypt-pos "$@"; }
```

سجّل حسابين (اكتب بريدك مكان `you@example.com`؛ Let's Encrypt يراسلك عليه فقط عند مشكلة في الشهادات):

```bash
cbpos register --agree-tos --no-eff-email -m you@example.com
cbpos register --staging --agree-tos --no-eff-email -m you@example.com
ls /etc/letsencrypt-pos/accounts/
# المتوقع مجلدان: acme-v02.api.letsencrypt.org و acme-staging-v02.api.letsencrypt.org
```

ملاحظة: certbot يقرأ أيضًا `/etc/letsencrypt/cli.ini` مهما كان مجلد الإعداد (`max-log-backups = 0` و`preconfigured-renewal = True`)، وكلاهما لا يضر.

**التجربة على staging:** فحص DNS (سجل A هو `108.61.190.4` تمامًا ولا يوجد AAAA)، ثم فحص `pos-probe` على المنفذ 80، ثم `certbot certonly --dry-run` على بيئة الاختبار. لا يُحفظ شيء:

```bash
/usr/bin/node /usr/local/sbin/pos-root-worker.mjs --trial admin.pos.108-61-190-4.sslip.io
```

المتوقع ثلاثة أسطر تنتهي بـ `certbot --dry-run (staging) succeeded`.

---

## 7. النشر الأول للتطبيق

```bash
systemctl enable pos.service
pos-deploy deploy multitenant      # أو: pos-deploy deploy main بعد دمج الفرع
```

يبني الإصدار في `/srv/pos/releases/<sha>`، ويثبّت الحزم، ويأخذ نسخة من `pos_control`، ويبدّل الرابط `current`، ويعيد تشغيل الخدمة، وينتظر حتى يعيد `/readyz` الـ sha الجديد. إن لم يجهز خلال 90 ثانية يطبع آخر سجلات الخدمة ويعود للإصدار السابق (في النشر الأول لا يوجد سابق).

```bash
systemctl status pos --no-pager | head -5
ss -ltnp | grep 3401                       # المتوقع: 127.0.0.1:3401 فقط
curl -sS -H 'Host: localhost' http://127.0.0.1:3401/readyz; echo
systemctl show pos -p MemoryCurrent
# المتغيرات التي يعرفها الإصدار مقابل ما في pos.env
diff <(grep -oE '^#? ?[A-Z_]+=' /srv/pos/current/.env.example | tr -d '# =' | sort -u) \
     <(grep -oE '^[A-Z_]+=' /etc/pos/pos.env | tr -d '=' | sort -u)
```

في نتيجة `diff`: الأسطر التي تبدأ بـ `<` متغيرات يعرفها التطبيق وليست في pos.env. أضف منها ما يلزم للإنتاج بـ nano ثم `systemctl restart pos`.

---

## 8. العامل وشهادة لوحة الإدارة

تشغيل أول يدوي للعامل داخل وحدته (بنفس قيود الحماية)، ثم تفعيل المؤقت:

```bash
systemctl start pos-root-worker.service
journalctl -u pos-root-worker -n 30 --no-pager      # المتوقع: لا أسطر خطأ
systemctl enable --now pos-root-worker.timer
```

اطلب شهادة لوحة الإدارة. الملف يُنشأ باسم المستخدم `pos` حتى يستطيع التطبيق إدارته لاحقًا:

```bash
runuser -u pos -- touch /var/lib/pos-spool/desired/admin.pos.108-61-190-4.sslip.io
```

بعد دقيقة إلى دقيقتين:

```bash
cat /var/lib/pos-spool/state/certs/admin.pos.108-61-190-4.sslip.io.json     # "status": "issued"
journalctl -u pos-root-worker --since -5min --no-pager
ls -l /etc/nginx/pos-certs/ /etc/nginx/pos-certs/admin.pos.108-61-190-4.sslip.io/
timeout 10 openssl s_client -connect 127.0.0.1:443 -servername admin.pos.108-61-190-4.sslip.io </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
curl -sS -o /dev/null -w '%{http_code}\n' https://admin.pos.108-61-190-4.sslip.io/    # المتوقع: 401 (لا مستخدم بعد)
pos-fingerprint > /root/pos-fp-after-cert.txt; diff /root/pos-fp-before.txt /root/pos-fp-after-cert.txt && echo "others unchanged"
```

إن بقيت الحالة `pending` فالسبب في `lastError` (فحص DNS، أو فحص المنفذ 80، أو رد Let's Encrypt)، والعامل يعيد المحاولة وحده بعد دقيقتين ثم 10 دقائق ثم ساعة. بعد ست محاولات فاشلة تصبح `failed`، ولإعادة المحاولة فورًا:

```bash
runuser -u pos -- touch /var/lib/pos-spool/desired/admin.pos.108-61-190-4.sslip.io
```

جرّب التجديد (على staging، لا يغيّر الشهادة). إن ظهر «Another instance of Certbot is already running» فالعامل يعمل في تلك اللحظة: أعد الأمر بعد ثوانٍ.

```bash
cbpos renew --dry-run --cert-name admin.pos.108-61-190-4.sslip.io
```

---

## 9. خطوات تنفذها أنت بنفسك

افتح جلسة SSH تفاعلية بنفسك (`ssh root@108.61.190.4`). هذه الأوامر تسألك عن كلمات المرور ولا تظهر على الشاشة ولا تُحفظ في سجل الأوامر. لا ترسل كلمات المرور لأي أحد.

**أ. كلمة مرور nginx أمام لوحة الإدارة** (الطبقة الأولى). اختر اسمًا مكان `boss`:

```bash
htpasswd -B /etc/nginx/.htpasswd-pos-admin boss
chown root:www-data /etc/nginx/.htpasswd-pos-admin && chmod 0640 /etc/nginx/.htpasswd-pos-admin
```

لا حاجة لإعادة تحميل nginx: الملف يُقرأ عند كل طلب.

**ب. حساب المسؤول في التطبيق** (كلمة مرور 14 حرفًا على الأقل، ثم رمز تحقق من تطبيق على هاتفك مثل Google Authenticator):

```bash
cd /srv/pos/current
runuser -u pos -- /usr/bin/node --env-file=/etc/pos/pos.env scripts/create-admin.js
cd ~
```

السكربت يسألك عن الاسم وكلمة المرور (لا تظهر أثناء الكتابة، ولا تُقبل في سطر الأمر)، ثم يعرض رابط `otpauth://` والمفتاح نفسه مقسّمًا إلى مجموعات من أربعة أحرف (لا يعرض رمز QR): أدخل المفتاح يدويًا في تطبيق المصادقة (النوع: حسب الوقت)، أو افتح الرابط على الهاتف. ثم يطبع 10 رموز احتياطية مرة واحدة فاحفظها في مكان آمن خارج الخادم، ويطلب الرمز الحالي من التطبيق ليفعّل الحساب. لتغيير كلمة المرور ورمز التحقق لاحقًا (هاتف ضائع): أضف `--reset`. إن قُفل الدخول بعد محاولات خاطئة: `runuser -u pos -- /usr/bin/node --env-file=/etc/pos/pos.env scripts/admin-unlock.js`.

**ج. التجربة:** افتح `https://admin.pos.108-61-190-4.sslip.io` من هاتفك: نافذة المتصفح تطلب اسم وكلمة مرور (أ)، ثم صفحة الدخول تطلب حساب المسؤول (ب)، ثم «رمز التحقق».

---

## 10. النسخ الليلية والمراقبة

```bash
systemctl start pos-backup.service          # نسخة أولى الآن
journalctl -u pos-backup -n 30 --no-pager
ls -la /var/backups/pos /var/backups/pos/pos_control
find /var/backups/pos -perm /077            # المتوقع: لا شيء
systemctl enable --now pos-backup.timer pos-monitor.timer
systemctl start pos-monitor.service; cat /var/lib/pos-spool/state/monitor.json
systemctl list-timers 'pos*' --no-pager
```

- **النسخ الليلي** في 03:30 بتوقيت بغداد (00:30 UTC): `pos_control` وكل قاعدة متجر غير محذوف، إلى `/var/backups/pos/<قاعدة>/<وقت UTC>-nightly.archive.gz`. كل ملف يُفحص (الضغط سليم كاملًا، وعدد المستندات في كل مجموعة محفوظ بجانبه). الاحتفاظ: 14 يومية، و8 أسبوعية، و6 شهرية. وكل أسبوع تُستعاد آخر نسخة لمتجر واحد إلى قاعدة مؤقتة وتُقارن الأعداد ثم تُحذف المؤقتة.
- **المراقبة** كل 5 دقائق: الذاكرة المتاحة (أقل من 300 MB)، القرص (أكثر من 80%)، `mongod` و`pos`، `/healthz`، الشهادات التي تنتهي خلال 14 يومًا، آخر نسخة ليلية (أقدم من 26 ساعة)، تمرين الاستعادة، آخر تشغيل ناجح للعامل، المهام الفاشلة، صلاحيات ملفات النسخ، وأخطاء 5xx من سجل التطبيق. المشاكل تظهر في `journalctl -u pos-monitor -p warning` وفي `monitor.json` الذي تعرضه لوحة الإدارة.
- قبل أول نسخة ليلية يظهر في المراقبة تنبيه «لم تكتمل أي نسخة احتياطية ليلية بعد»، وهذا متوقع.

---

## 11. المتجر الأول smoke

من لوحة الإدارة: «متجر جديد»، العنوان `smoke`، واسم المتجر على الإيصال، واسم مستخدم المالك. انسخ كلمة المرور المؤقتة التي تظهر (لا تُعرض مرة أخرى؛ عند أول دخول يُطلب من صاحب المتجر تغييرها، ويمكنك إعادة تعيينها من صفحة المتجر في اللوحة). شاشة التقدم تنتهي بـ «جاهز» بعد إصدار الشهادة، خلال دقيقتين عادة.

إن لم تكن اللوحة جاهزة بعد، فالبديل من سطر الأوامر ثم طلب الشهادة يدويًا:

```bash
cd /srv/pos/current
runuser -u pos -- /usr/bin/node --env-file=/etc/pos/pos.env scripts/tenant-create.js --slug smoke --name "اسم المتجر"
runuser -u pos -- touch /var/lib/pos-spool/desired/smoke.pos.108-61-190-4.sslip.io
cd ~
```

**فحص 401** قبل إعطاء العنوان لأي أحد: كل مسارات البيانات بلا تسجيل دخول يجب أن تعيد 401، والصفحات تحوّل إلى صفحة الدخول.

```bash
S=https://smoke.pos.108-61-190-4.sslip.io
for p in /api/shop /api/categories /api/products /api/sales /api/expenses /api/customers /api/stockcounts /api/purchases /api/auth/me /api/settings; do
  printf '%-20s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$S$p")"
done
curl -s -o /dev/null -w 'cashier.html: %{http_code} %{redirect_url}\n' "$S/cashier.html"
curl -s -w '\n' "$S/api/auth/shop"     # عام: اسم المتجر فقط
```

إن أعاد أي مسار 200 ببيانات فلا تعطِ العنوان لأحد: فعّل كلمة مرور nginx أمام كل المتاجر مؤقتًا حتى يُصلح التطبيق. أنت تنشئ الملف (`htpasswd -c -B /etc/nginx/.htpasswd-pos <اسم>` ثم `chown root:www-data` و`chmod 0640`)، ثم أزل علامة `#` من سطري `auth_basic` في كتلة المتاجر في `/etc/nginx/sites-available/pos`، ثم `nginx -t && systemctl reload nginx`.

**على أجهزتك:** ماسح الكاميرا يعمل عبر HTTPS، وقارئ الباركود USB يعمل، والإيصال يعرض اسم المتجر، والبيع والمرتجع والتقرير مطابقة للمتوقع.

**تجربة النسخ والاستعادة على smoke** (بعد أول بيع تجريبي، حتى لا تكون القاعدة فارغة). نسخة يدوية كما تطلبها اللوحة، بطلب يكتبه المستخدم `pos`:

```bash
TID=$(mongosh --quiet --eval 'db.getSiblingDB("pos_control").tenants.findOne({ slug: "smoke" })._id.toHexString()')
DB=$(mongosh --quiet --eval 'db.getSiblingDB("pos_control").tenants.findOne({ slug: "smoke" }).dbName')
ID=$(openssl rand -hex 12); echo "$TID $DB $ID"
runuser -u pos -- /usr/bin/node -e '
const [tenantId, dbName, id] = process.argv.slice(1);
const fs = require("fs");
const file = `/var/lib/pos-spool/requests/${id}.json`;
fs.writeFileSync(`${file}.tmp`, JSON.stringify({ type: "backup", tenantId, dbName, reason: "manual" }));
fs.renameSync(`${file}.tmp`, file);' "$TID" "$DB" "$ID"
```

بعد دقيقة أو اثنتين: `cat /var/lib/pos-spool/state/jobs/$ID.json` يجب أن يعطي `"status": "done"` مع أعداد المجموعات (`counts`) ومسار النسخة. ثم تمرين الاستعادة الأسبوعي فورًا (يستعيد آخر نسخة ليلية إلى قاعدة مؤقتة ويقارن الأعداد):

```bash
rm -f /var/lib/pos-root-worker/drill.json && systemctl start pos-backup.service
/usr/bin/node /usr/local/sbin/pos-root-worker.mjs --status | tail -2     # drill ... ok
find /var/backups/pos -perm /077                                          # لا شيء
```

---

## 12. تحويل العنوان القديم وإيقاف smoke-shop

```bash
cp -a /etc/nginx/sites-available/smoke-shop /root/backups/smoke-shop.$(date -u +%Y%m%dT%H%M%SZ)
cat /etc/nginx/sites-available/smoke-shop
```

قارن مع `/root/pos-ops/ops/nginx/smoke-shop-redirect.conf`: إن كان في الملف الحالي سطر `include` (مثل `/etc/letsencrypt/options-ssl-nginx.conf`) أو `ssl_dhparam` أو أي `ssl_*` فانسخه إلى الملف الجديد كما هو بـ nano بعد التثبيت. ثم:

```bash
pos-fingerprint > /root/pos-fp-before-redirect.txt
install -o root -g root -m 0644 /root/pos-ops/ops/nginx/smoke-shop-redirect.conf /etc/nginx/sites-available/smoke-shop
nginx -t && systemctl reload nginx
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://smoke.108-61-190-4.sslip.io/cashier.html
# المتوقع: 302 https://smoke.pos.108-61-190-4.sslip.io/cashier.html
pos-fingerprint > /root/pos-fp-after-redirect.txt
diff /root/pos-fp-before-redirect.txt /root/pos-fp-after-redirect.txt
```

الفرق المتوقع سطران فقط: سطر `smoke.108-61-190-4.sslip.io` (الحالة 302 بدل 401، والبصمة نفسها لأن الشهادة لم تتغير)، وسطر `sha256sum` لملف `sites-available/smoke-shop`. أي فرق آخر: أعد الملف المحفوظ وأعد التحميل.

شهادة العنوان القديم تبقى في `/etc/letsencrypt` ويجددها `certbot.timer` كما اليوم. انظر سطر `authenticator` الذي حفظته في الخطوة 1: إن كان `webroot` فلا شيء يتغير (المنفذ 80 يجيب عليه موقع niura الافتراضي كما كان). إن كان `nginx` فجرّب تجديد هذه الشهادة وحدها مرة: `certbot renew --cert-name smoke.108-61-190-4.sslip.io --dry-run`.

ثم أوقف التطبيق القديم (يبقى مثبتًا للتراجع 30 يومًا):

```bash
pm2 stop smoke-shop && pm2 save
pm2 ls
```

**بعد أسبوعين** دون مشاكل: التحويل الدائم 301.

```bash
sed -i 's/return 302 /return 301 /' /etc/nginx/sites-available/smoke-shop && nginx -t && systemctl reload nginx
```

---

## 13. التراجع الكامل

بالترتيب. كل خطوة مستقلة، ويمكن التوقف بعد أي منها:

```bash
# 1. إيقاف المؤقتات الثلاثة والخدمة
systemctl disable --now pos-root-worker.timer pos-backup.timer pos-monitor.timer
systemctl disable --now pos.service

# 2. إزالة موقع نقطة البيع من nginx
rm /etc/nginx/sites-enabled/pos && nginx -t && systemctl reload nginx

# 3. إعادة ملف موقع smoke القديم (اسم الملف من الخطوة 12)
ls /root/backups/smoke-shop.*
cp -a /root/backups/smoke-shop.<الوقت> /etc/nginx/sites-available/smoke-shop && nginx -t && systemctl reload nginx

# 4. تشغيل التطبيق القديم
pm2 restart smoke-shop && pm2 save

# 5. التحقق: كل المواقع كما كانت قبل البدء
pos-fingerprint > /root/pos-fp-rollback.txt; diff /root/pos-fp-before.txt /root/pos-fp-rollback.txt
```

المتوقع: لا فرق. ملفات نقطة البيع (`sites-available/pos` والمقطع وملفا htpasswd والشهادات) مستثناة من البصمة، وتبقى على القرص بلا أثر لأن رابطها في `sites-enabled` حُذف.

**6. (اختياري) نقل بيانات متجر smoke إلى التطبيق القديم.** البيانات تجريبية، فلا حاجة عادة. إن أردت: خذ نسخة من القاعدة القديمة أولًا، ثم انقل المجموعات (أسماؤها لم تتغير، فيقرؤها الكود القديم كما هي) ما عدا `users` و`settings`:

```bash
DB=$(mongosh --quiet --eval 'db.getSiblingDB("pos_control").tenants.findOne({ slug: "smoke" }).dbName'); echo "$DB"
mongodump --db smoke_shop --gzip --archive=/root/backups/smoke_shop-$(date -u +%Y%m%dT%H%M%SZ).archive.gz
mongodump --db "$DB" --archive | mongorestore --archive --drop --nsInclude="$DB.*" \
  --nsExclude="$DB.users" --nsExclude="$DB.settings" --nsFrom="$DB.*" --nsTo='smoke_shop.*'
pm2 restart smoke-shop
```

**تراجع جزئي:** للعودة إلى إصدار سابق من التطبيق فقط: `pos-deploy rollback`. لإلغاء موقع nginx فقط: الخطوة 2.

**إزالة كاملة** (فقط إن تقرر ترك النظام نهائيًا، وبعد نسخ ما تريد من `/var/backups/pos`): القواعد `pos_*` تُحذف من mongosh، والمجلدات والمستخدم:

```bash
rm -f /etc/systemd/system/pos*.service /etc/systemd/system/pos*.timer && systemctl daemon-reload
rm -f /etc/nginx/sites-available/pos /etc/nginx/snippets/pos-proxy.conf /etc/nginx/.htpasswd-pos-admin /etc/nginx/.htpasswd-pos
rm -rf /etc/nginx/pos-certs /etc/letsencrypt-pos /var/lib/letsencrypt-pos /var/log/letsencrypt-pos /var/lib/pos-spool /var/lib/pos-root-worker /srv/pos /etc/pos
rm -f /usr/local/sbin/pos-root-worker.mjs /usr/local/sbin/pos-monitor.mjs /usr/local/sbin/pos-deploy /usr/local/sbin/pos-fingerprint
userdel pos
```

---

## 14. العمليات اليومية

**النشر:**

```bash
pos-deploy deploy main          # آخر نسخة من الفرع main
pos-deploy status               # الإصدار الحالي والسابق والمحفوظة، وحالة /readyz
pos-deploy rollback             # العودة إلى الإصدار السابق
pos-deploy rollback 1a2b3c4     # أو إلى إصدار محدد من القائمة
```

النشر خارج ساعات العمل: التوقف ثانية إلى ثلاث، وإعادة إرسال البيع من الكاشير لا تكرره. قبل كل تبديل تُحفظ نسخة من `pos_control` في `/var/backups/pos/deploy/` (آخر 10). إذا أعاد الإصدار السابق أخطاء بعد إصدار غيّر `pos_control`، فاستعد تلك النسخة والخدمة متوقفة:

```bash
systemctl stop pos
mongorestore --drop --gzip --archive=/var/backups/pos/deploy/pos_control-<الوقت>.archive.gz --nsInclude='pos_control.*'
systemctl start pos
```

**تحديث ملفات التشغيل** (العامل والمراقبة ووحدات systemd وnginx) عندما يغيّرها إصدار جديد: لا تُنسخ تلقائيًا. راجع الفرق ثم انسخ:

```bash
diff /usr/local/sbin/pos-root-worker.mjs /srv/pos/current/ops/sbin/pos-root-worker.mjs
install -o root -g root -m 0700 /srv/pos/current/ops/sbin/pos-root-worker.mjs /usr/local/sbin/pos-root-worker.mjs
# ومثله لـ pos-monitor.mjs و deploy.sh (-> pos-deploy). للوحدات: install ثم systemctl daemon-reload.
# لملفات nginx: البصمة قبل، install، nginx -t && systemctl reload nginx، البصمة بعد، diff.
```

**الحالة والسجلات:**

```bash
/usr/bin/node /usr/local/sbin/pos-root-worker.mjs --status     # الشهادات والمهام وآخر نسخة وتمرين
cat /var/lib/pos-spool/state/monitor.json
systemctl list-timers 'pos*' --no-pager
journalctl -u pos -f                                           # التطبيق
journalctl -u pos-root-worker --since today --no-pager         # الشهادات والمهام
journalctl -u pos-backup -n 50 --no-pager                      # النسخ الليلي
journalctl -u pos-monitor -p warning --since -1d --no-pager    # مشاكل المراقبة
tail -f /var/log/nginx/pos.access.log /var/log/nginx/pos.error.log
less /var/log/letsencrypt-pos/letsencrypt.log
free -m; systemctl show pos -p MemoryCurrent -p MemoryPeak
ss -ltnp | grep 3401                                           # 127.0.0.1 فقط دائمًا
```

**النسخ الاحتياطية:**

```bash
ls -lh /var/backups/pos/*/                       # كل النسخ، لكل قاعدة مجلد
cat /var/lib/pos-spool/state/backups/<القاعدة>.json
systemctl start pos-backup.service               # نسخة ليلية الآن
```

«نسخة الآن» لمتجر واحد تكون من صفحته في لوحة الإدارة: التطبيق يكتب طلبًا في `requests/`، والعامل يأخذ النسخة ويستعيدها في قاعدة مؤقتة ويقارن الأعداد قبل أن يعتبرها صالحة.

**الاستعادة:** من لوحة الإدارة (المرحلة 7): العامل يستعيد النسخة إلى قاعدة **جديدة** دائمًا ولا يكتب فوق قاعدة موجودة، ثم يبدّل التطبيق المتجر إليها. لفحص محتوى نسخة يدويًا دون أن تلمس المتجر، استعدها إلى قاعدة فحص ثم احذفها:

```bash
F=/var/backups/pos/pos_t_<id>/<الوقت>-nightly.archive.gz
mongorestore --gzip --archive="$F" --nsInclude='pos_t_<id>.*' --nsFrom='pos_t_<id>.*' --nsTo='pos_check.*'
mongosh --quiet --eval 'const d = db.getSiblingDB("pos_check"); d.getCollectionNames().forEach((c) => print(c, d[c].countDocuments({})))'
mongosh --quiet --eval 'db.getSiblingDB("pos_check").dropDatabase()'
```

إن توقفت مهمة استعادة في منتصفها (إعادة تشغيل الخادم مثلًا) فحالتها تصبح `failed` في التشغيل التالي، وقد تبقى قاعدة الهدف ناقصة: اطلب الاستعادة من جديد إلى قاعدة هدف جديدة.

**الشهادات:**

```bash
cat /var/lib/pos-spool/state/certs/<العنوان>.json
runuser -u pos -- touch /var/lib/pos-spool/desired/<العنوان>       # إعادة المحاولة بعد failed
/usr/bin/node /usr/local/sbin/pos-root-worker.mjs --install <العنوان>   # إعادة نسخ الشهادة إلى nginx
cbpos renew --dry-run                                                # فحص التجديد كله (staging)
```

التجديد تلقائي مرتين يوميًا لكل عنوان بقي له أقل من 35 يومًا، ولا يحتاج nginx إعادة تحميل. حدود الإصدار الذاتية: 3 شهادات في كل تشغيل و15 في اليوم.

**إعدادات التطبيق:** رفع `MAX_TENANTS` أو `MAX_NEW_TENANTS_PER_DAY` يكون في `/etc/pos/pos.env` فقط، ثم `systemctl restart pos`. الحد على هذا الخادم 20 متجرًا حتى يُقاس غير ذلك.

**كلمات المرور:** كلمة مرور صاحب متجر تُعاد تعيينها من صفحة المتجر في اللوحة (كلمة مؤقتة جديدة، تُلغى كل جلساته، ويُطلب تغييرها عند الدخول). كلمة مرور nginx للوحة: الأمر `htpasswd -B /etc/nginx/.htpasswd-pos-admin <الاسم>` في جلسة تفاعلية.

---

## ملحق: مجلد الطلبات بين التطبيق والعامل

التطبيق (المستخدم `pos`) لا يملك أي صلاحية root، فيطلب ما يحتاجه بملفات في `/var/lib/pos-spool`، والعامل (root، كل دقيقة) ينفّذ ويكتب النتيجة:

| المسار | يكتبه | المعنى |
|---|---|---|
| `desired/<العنوان>` | التطبيق، ملف فارغ | أصدر شهادة لهذا العنوان وجددها. لمسه من جديد بعد `failed` يعيد المحاولة |
| `retire/<العنوان>` | التطبيق، ملف فارغ | احذف شهادة العنوان بعد 24 ساعة وأوقف تجديدها. العامل يحذف الملفين عند الانتهاء |
| `requests/<jobId>.json` | التطبيق (`.tmp` ثم إعادة تسمية) | مهمة `backup` أو `restore` أو `drop`. العامل يحذف الطلب بعد كتابة حالته |
| `state/certs/<العنوان>.json` | العامل | `pending` أو `issued` أو `failed` أو `retired`، مع المحاولات وموعد التالية وتاريخ الانتهاء وآخر خطأ |
| `state/jobs/<jobId>.json` | العامل | `running` أو `done` أو `failed`، مع النتيجة (`result` يساوي `null` حتى `done`) أو الخطأ |
| `state/backups/<القاعدة>.json` | العامل | قائمة النسخ لكل قاعدة كما تعرضها اللوحة |
| `state/monitor.json` | pos-monitor | آخر فحص ومشاكله |

**ما يرفضه العامل ويسجّله مرة واحدة:** أي اسم لا يطابق `^[a-z][a-z0-9-]{1,28}[a-z0-9]\.pos\.108-61-190-4\.sslip\.io$` (أو عنوان الإدارة)، وأي ملف ليس ملفًا عاديًا (رابط رمزي، مجلد، رابط صلب) أو ليس فارغًا في `desired` و`retire`، وأي طلب حقوله غير حقول نوعه بالضبط، وأي قاعدة لا تطابق `^pos_t_[0-9a-f]{24}$`، وأي مسار نسخة خارج `/var/backups/pos/<القاعدة>/` أو يمر برابط رمزي.

**ضمانات الحذف (`drop`):** القاعدة لا تُحذف إلا إذا كانت النسخة المذكورة في الطلب أخذها العامل نفسه وتحقق منها باستعادة كاملة، ولم يتغير الملف بعدها (SHA-256)، ولا يستخدم القاعدة أي متجر حالته `provisioning` أو `active` أو `suspended`.
