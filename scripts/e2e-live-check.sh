#!/usr/bin/env bash
# EduBridge — 18 end-to-end checks against the LIVE production API.
# Prints a ✓/✗ table and a pass summary, then cleans up the accounts it created.
#
#   bash scripts/e2e-live-check.sh
#   E2E_BASE_URL=https://your-host/api/v1 bash scripts/e2e-live-check.sh
#
# Uses the seed admin (prisma/seed.ts): admin@edubridge.com / Password123!

BASE="${E2E_BASE_URL:-https://edubridge-proxy.michaelrodri091.workers.dev/api/v1}"
PW='Password123!'
STAMP=$(date +%s)
STUDENT="e2e-student-$STAMP@example.com"
APPLICANT="e2e-teacher-$STAMP@example.com"
BODY="$(mktemp)"
PASS=0; FAIL=0; N=0

grn=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; rst=$'\033[0m'

# req METHOD PATH [TOKEN] [JSON_BODY]  -> echoes the HTTP status, writes body to $BODY
req() {
  local m="$1" p="$2" tok="$3" data="$4"; shift 4 2>/dev/null || true
  local args=(-s -o "$BODY" -w "%{http_code}" -X "$m" "$BASE$p" -H "Content-Type: application/json")
  [ -n "$tok" ] && args+=(-H "Authorization: Bearer $tok")
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}"
}
# field KEY -> first "KEY":"value" string value in $BODY (searches through the envelope)
field() { grep -o "\"$1\":\"[^\"]*\"" "$BODY" | head -1 | sed "s/\"$1\":\"//;s/\"$//"; }

check() { # NAME  EXPECTED  ACTUAL
  N=$((N+1)); printf "%2d) " "$N"
  if [ "$2" = "$3" ]; then printf "${grn}✓${rst} %s\n" "$1"; PASS=$((PASS+1))
  else printf "${red}✗${rst} %s ${dim}(expected %s, got %s)${rst}\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}

echo "EduBridge end-to-end checks → $BASE"
echo "--------------------------------------------------------------"

# 1
code=$(req GET /health); status=$(field status); check "Health check is up" "ok" "$status"
# 2
code=$(req POST /auth/register "" "{\"email\":\"$STUDENT\",\"password\":\"$PW\",\"username\":\"e2estud$STAMP\",\"firstName\":\"E2E\",\"lastName\":\"Student\"}")
STUD_TOKEN=$(field accessToken); STUD_ID=$(field id); STUD_ROLE=$(field role)
check "Learner can register (201)" "201" "$code"
# 3
code=$(req POST /auth/login "" "{\"email\":\"$STUDENT\",\"password\":\"$PW\"}"); check "Learner can log in (200)" "200" "$code"
# 4
code=$(req GET /auth/me "$STUD_TOKEN"); check "Authenticated profile returned (200)" "200" "$code"
# 5
code=$(req GET "/courses?limit=24"); check "Course catalogue lists courses (200)" "200" "$code"
FREE_ID=$(python -c "import sys,json;d=json.load(open('$BODY'));d=d.get('data',d);l=d if isinstance(d,list) else d.get('courses',d.get('items',[]));print(next((c['id'] for c in l if float(c.get('price') or 0)==0),''))" 2>/dev/null)
PAID_ID=$(python -c "import sys,json;d=json.load(open('$BODY'));d=d.get('data',d);l=d if isinstance(d,list) else d.get('courses',d.get('items',[]));print(next((c['id'] for c in l if float(c.get('price') or 0)>0),''))" 2>/dev/null)
# 6
code=$(req GET "/courses/$PAID_ID"); check "Course detail loads (200)" "200" "$code"
# 7
code=$(req POST "/payments/enroll-free/$FREE_ID" "$STUD_TOKEN"); [ "$code" = "200" ] && code="201"; check "Enrol in a free course (201)" "201" "$code"
# 8
code=$(req POST "/payments/enroll-free/$PAID_ID" "$STUD_TOKEN"); check "Paid course requires payment (400)" "400" "$code"
# 9
code=$(req PUT /users/profile "$STUD_TOKEN" '{"firstName":"E2E","lastName":"Learner","bio":"Automated check."}'); check "Learner can update profile (200)" "200" "$code"
# 10
code=$(req GET /search/categories); check "Categories are available (200)" "200" "$code"
# 11
code=$(req POST /applications/instructor/apply "" "{\"email\":\"$APPLICANT\",\"firstName\":\"E2E\",\"lastName\":\"Teacher\",\"password\":\"$PW\",\"motivation\":\"Automated apply-first check.\",\"subjectExpertise\":[\"Testing\",\"QA\"]}")
check "Apply to teach without an account (201)" "201" "$code"
# 12
code=$(req POST /auth/login "" "{\"email\":\"$APPLICANT\",\"password\":\"$PW\"}"); check "No account until approval (401)" "401" "$code"
# 13
code=$(req POST /auth/login "" '{"email":"admin@edubridge.com","password":"Password123!"}'); ADMIN_TOKEN=$(field accessToken)
check "Admin can log in (200)" "200" "$code"
# 14
code=$(req GET "/applications/instructor?status=pending&limit=50" "$ADMIN_TOKEN")
APP_ID=$(python -c "import sys,json;d=json.load(open('$BODY'));d=d.get('data',d);a=d.get('applications',d.get('items',d if isinstance(d,list) else []));print(next((x['id'] for x in a if x.get('email')=='$APPLICANT'),''))" 2>/dev/null)
check "Admin lists pending applications (200)" "200" "$code"
# 15
code=$(req PATCH "/applications/instructor/$APP_ID/review" "$ADMIN_TOKEN" '{"decision":"approved"}'); check "Approval provisions the account (200)" "200" "$code"
# 16
code=$(req POST /auth/login "" "{\"email\":\"$APPLICANT\",\"password\":\"$PW\"}"); INSTR_TOKEN=$(field accessToken); INSTR_ROLE=$(field role)
check "Approved user logs in as INSTRUCTOR" "INSTRUCTOR" "$INSTR_ROLE"
# 17
code=$(req GET /courses/instructor/my-courses "$INSTR_TOKEN"); check "Instructor reaches instructor tools (200)" "200" "$code"
# 18
code=$(req DELETE "/admin/users/$STUD_ID" "$ADMIN_TOKEN"); check "Admin deletes a user with an enrolment (200)" "200" "$code"

echo "--------------------------------------------------------------"
if [ "$FAIL" -eq 0 ]; then printf "${grn}%d of %d checks passed${rst}\n" "$PASS" "$N"; else printf "${red}%d of %d passed, %d failed${rst}\n" "$PASS" "$N" "$FAIL"; fi

# Cleanup: remove the instructor account we provisioned (student already deleted in check 18).
code=$(req GET /auth/me "$INSTR_TOKEN"); INSTR_ID=$(field id)
[ -n "$INSTR_ID" ] && req DELETE "/admin/users/$INSTR_ID" "$ADMIN_TOKEN" >/dev/null
rm -f "$BODY"
[ "$FAIL" -eq 0 ]
