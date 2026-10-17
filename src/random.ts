const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++)
    c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(text: string): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < text.length; i++)
    crc = CRC_TABLE[(crc ^ text.charCodeAt(i)) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62(value: number, width: number): string {
  let out = ''
  for (let rest = value; rest > 0; rest = Math.floor(rest / 62))
    out = BASE62[rest % 62] + out
  return out.padStart(width, '0')
}

/**
 * Whether a classic GitHub token's last six characters are the CRC32 of its
 * random part. GitHub has issued every `gh?_` token in this form since 2021;
 * one typed by hand or made up for a test passes by chance once in 2^32.
 */
export function hasGitHubChecksum(token: string): boolean {
  return base62(crc32(token.slice(4, -6)), 6) === token.slice(-6)
}

/** `token`'s random part with the checksum GitHub would append, for test fakes. */
export function withGitHubChecksum(prefix: string, body: string): string {
  return `${prefix}${body}${base62(crc32(body), 6)}`
}

// Pairs that turn up far more often in identifiers, paths and words than in
// random text, taken from ripsecrets, where they were calibrated for base64.
const COMMON_BIGRAMS = new Set('er,te,an,en,ma,ke,10,at,/m,on,09,ti,al,io,.h,./,..,ra,ht,es,or,tm,pe,ml,re,in,3/,n3,0F,ok,ey,00,80,08,ss,07,15,81,F3,st,52,KE,To,01,it,2B,2C,/E,P_,EY,B7,se,73,de,VP,EV,to,od,B0,0E,nt,et,_P,A0,60,90,0A,ri,30,ar,C0,op,03,ec,ns,as,FF,F7,po,PK,la,.p,AE,62,me,F4,71,8E,yp,pa,50,qu,D7,7D,rs,ea,Y_,t_,ha,3B,c/,D2,ls,DE,pr,am,E0,oc,06,li,do,id,05,51,40,ED,_p,70,ed,04,02,t.,rd,mp,20,d_,co,ro,ex,11,ua,nd,0C,0D,D0,Eq,le,EF,wo,e_,e.,ct,0B,_c,Li,45,rT,pt,14,61,Th,56,sT,E6,DF,nT,16,85,em,BF,9E,ne,_s,25,91,78,57,BE,ta,ng,cl,_t,E1,1F,y_,xp,cr,4F,si,s_,E5,pl,AB,ge,7E,F8,35,E2,s.,CF,58,32,2F,E7,1B,ve,B1,3D,nc,Gr,EB,C6,77,64,sl,8A,6A,_k,79,C8,88,ce,Ex,5C,28,EA,A6,2A,Ke,A7,th,CA,ry,F0,B6,7/,D9,6B,4D,DA,3C,ue,n7,9C,.c,7B,72,ac,98,22,/o,va,2D,n.,_m,B8,A3,8D,n_,12,nE,ca,3A,is,AD,rt,r_,l-,_C,n1,_v,y.,yw,1/,ov,_n,_d,ut,no,ul,sa,CT,_K,SS,_e,F1,ty,ou,nG,tr,s/,il,na,iv,L_,AA,da,Ty,EC,ur,TX,xt,lu,No,r.,SL,Re,sw,_1,om,e/,Pa,xc,_g,_a,X_,/e,vi,ds,ai,==,ts,ni,mg,ic,o/,mt,gm,pk,d.,ch,/p,tu,sp,17,/c,ym,ot,ki,Te,FE,ub,nL,eL,.k,if,he,34,e-,23,ze,rE,iz,St,EE,-p,be,In,ER,67,13,yn,ig,ib,_f,.o,el,55,Un,21,fi,54,mo,mb,gi,_r,Qu,FD,-o,ie,fo,As,7F,48,41,/i,eS,ab,FB,1E,h_,ef,rr,rc,di,b.,ol,im,eg,ap,_l,Se,19,oS,ew,bs,Su,F5,Co,BC,ud,C1,r-,ia,_o,65,.r,sk,o_,ck,CD,Am,9F,un,fa,F6,5F,nk,lo,ev,/f,.t,sE,nO,a_,EN,E4,Di,AC,95,74,1_,1A,us,ly,ll,_b,SA,FC,69,5E,43,um,tT,OS,CE,87,7A,59,44,t-,bl,ad,Or,D5,A_,31,24,t/,ph,mm,f.,ag,RS,Of,It,FA,De,1D,/d,-k,lf,hr,gu,fy,D6,89,6F,4E,/k,w_,cu,br,TE,ST,R_,E8,/O'.split(','))

function choose(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i++)
    result = result * (n - k + i) / i
  return result
}

/** The probability of a count at least as far from `n * p` as `x`, on its side. */
function binomialTail(n: number, x: number, p: number): number {
  const [from, to] = x < n * p ? [0, x] : [x, n]
  let total = 0
  for (let i = from; i <= to; i++)
    total += choose(n, i) * p ** i * (1 - p) ** (n - i)
  return total
}

// The ways to spread n positions over exactly k symbols, each used at least
// once: a Stirling number of the second kind. Rows are kept, since every
// judged value of length n reads from row n.
const STIRLING: number[][] = [[1]]

function partitions(n: number, k: number): number {
  for (let i = STIRLING.length; i <= n; i++) {
    const last = STIRLING[i - 1]!
    STIRLING.push(Array.from({ length: i + 1 }, (_, j) => j === 0 ? 0 : j * (last[j] ?? 0) + (last[j - 1] ?? 0)))
  }
  return STIRLING[n]![k] ?? 0
}

function pDistinct(value: string, base: number): number {
  const distinct = new Set(value).size
  let outcomes = 0
  for (let k = 1; k <= distinct; k++) {
    let symbols = 1
    for (let i = 0; i < k; i++)
      symbols *= base - i
    outcomes += symbols * partitions(value.length, k)
  }
  return outcomes / base ** value.length
}

const CLASSES: [RegExp, number][] = [[/\d/, 10], [/[A-Z]/, 26], [/[a-z]/, 26]]

function count(value: string, test: RegExp): number {
  return [...value].filter(c => test.test(c)).length
}

/**
 * How likely `value` is to show what it shows if it were random: few distinct
 * characters, a lopsided share of digits or of one case, and pairs common in
 * words and identifiers. Plain Shannon entropy cannot tell a 20-character
 * camelCase name from a key; these counts can. Ported from ripsecrets.
 */
function pRandom(value: string): number {
  const base = /^[0-9a-f]+$/i.test(value) ? 16 : /^[0-9A-Z]+$/.test(value) ? 36 : 64
  const classes = CLASSES.slice(0, base === 16 ? 1 : base === 36 ? 2 : 3)
  const pClass = Math.min(...classes.map(([test, size]) => binomialTail(value.length, count(value, test), size / base)))
  let p = pDistinct(value, base) * pClass
  if (base === 64) {
    let pairs = 0
    for (let i = 0; i + 1 < value.length; i++) {
      if (COMMON_BIGRAMS.has(value.slice(i, i + 2)))
        pairs++
    }
    p *= binomialTail(value.length, pairs, COMMON_BIGRAMS.size / 4096)
  }
  return p
}

// Above this the products below lose all precision, and a value this long
// that reached the generic rule is a blob, not a credential typed in.
const MAX_JUDGED_LENGTH = 100

/** Whether `value` reads as machine-generated rather than a word or a name. */
export function isRandom(value: string): boolean {
  if (value.length > MAX_JUDGED_LENGTH)
    return true
  const p = pRandom(value)
  return p >= 1e-5 && (/\d/.test(value) || p >= 1e-4)
}
