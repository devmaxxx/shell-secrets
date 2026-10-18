export const BOUNDARY_BEFORE = '(?<![A-Za-z0-9_-])'

export const BOUNDARY_AFTER = '(?![A-Za-z0-9_-])'

export const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++)
    c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export const DEV_HOSTS = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/

export const DEV_PASSWORDS
  = /^(?:pass(?:word)?|pwd|secret|token|hunter2|postgres|mongo|redis|root|admin|test|user)$/i

// Names RFC 2606 reserves for documentation and tests, which never resolve.
export const RESERVED_HOST = /(?:^|\.)(?:example\.(?:com|net|org)|[^.]+\.(?:example|invalid|test|localhost))$/i

export const SEQUENCES = (() => {
  const digits = '0123456789'
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const runs = [`${upper}${upper.toLowerCase()}${digits}+/`, `${digits}${upper}`, '0123456789ABCDEF', `${upper}=/`]
  return [...runs, ...runs.map(run => [...run].reverse().join(''))].map(run => (run + run).toUpperCase())
})()

// A UUID under a secret's name is a key (Heroku issues them so). Hex with
// dashes reads as low-variety to the randomness test, so it is let through
// on its shape.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MEMBER_PATH = /^[A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)+$/i

// A bare leading `/` is left out: one random base64 value in 64 starts with it.
export const FILE_PATH = /^(?:\.{1,2}\/|~\/|[A-Z]:\\)/i

// A type or class name built of words, with digits that get it past the
// randomness test. A random key falls into this shape about once in 4000.
export const IDENTIFIER_WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g

// A digest of a secret (`hashed_secret`, `token_sha256`), a public key, or a
// file named after one (`token.go`) is not the secret itself. A word only
// counts in the place it names something else: `hash_secret` and
// `public_secret` are secrets, `api.key` is no file, and `hashicorp_vault_token`
// is a token.
export const NOT_A_SECRET_NAME = /(?:^|_)(?:hashed|digest|checksum|fingerprint)(?:_|$)|_(?:hash|sha\d*)$|(?:^|_)(?:public|publishable)_key$/

export const FILE_NAME = /\.(?:go|[cm]?[jt]sx?|py|rb|rs|java|kt|php|cs|swift|[ch](?:pp)?|json|ya?ml|toml|ini|env|pem|crt|txt|md|sh|cfg|conf|xml|tf)$/

// `token_id` names a token; the UUID under it is a record's id, not a key.
export const ID_NAME = /(?:^|_)(?:id|uuid|guid)$/

// Pairs that turn up far more often in identifiers, paths and words than in
// random text, taken from ripsecrets, where they were calibrated for base64.
export const COMMON_BIGRAMS = new Set('er,te,an,en,ma,ke,10,at,/m,on,09,ti,al,io,.h,./,..,ra,ht,es,or,tm,pe,ml,re,in,3/,n3,0F,ok,ey,00,80,08,ss,07,15,81,F3,st,52,KE,To,01,it,2B,2C,/E,P_,EY,B7,se,73,de,VP,EV,to,od,B0,0E,nt,et,_P,A0,60,90,0A,ri,30,ar,C0,op,03,ec,ns,as,FF,F7,po,PK,la,.p,AE,62,me,F4,71,8E,yp,pa,50,qu,D7,7D,rs,ea,Y_,t_,ha,3B,c/,D2,ls,DE,pr,am,E0,oc,06,li,do,id,05,51,40,ED,_p,70,ed,04,02,t.,rd,mp,20,d_,co,ro,ex,11,ua,nd,0C,0D,D0,Eq,le,EF,wo,e_,e.,ct,0B,_c,Li,45,rT,pt,14,61,Th,56,sT,E6,DF,nT,16,85,em,BF,9E,ne,_s,25,91,78,57,BE,ta,ng,cl,_t,E1,1F,y_,xp,cr,4F,si,s_,E5,pl,AB,ge,7E,F8,35,E2,s.,CF,58,32,2F,E7,1B,ve,B1,3D,nc,Gr,EB,C6,77,64,sl,8A,6A,_k,79,C8,88,ce,Ex,5C,28,EA,A6,2A,Ke,A7,th,CA,ry,F0,B6,7/,D9,6B,4D,DA,3C,ue,n7,9C,.c,7B,72,ac,98,22,/o,va,2D,n.,_m,B8,A3,8D,n_,12,nE,ca,3A,is,AD,rt,r_,l-,_C,n1,_v,y.,yw,1/,ov,_n,_d,ut,no,ul,sa,CT,_K,SS,_e,F1,ty,ou,nG,tr,s/,il,na,iv,L_,AA,da,Ty,EC,ur,TX,xt,lu,No,r.,SL,Re,sw,_1,om,e/,Pa,xc,_g,_a,X_,/e,vi,ds,ai,==,ts,ni,mg,ic,o/,mt,gm,pk,d.,ch,/p,tu,sp,17,/c,ym,ot,ki,Te,FE,ub,nL,eL,.k,if,he,34,e-,23,ze,rE,iz,St,EE,-p,be,In,ER,67,13,yn,ig,ib,_f,.o,el,55,Un,21,fi,54,mo,mb,gi,_r,Qu,FD,-o,ie,fo,As,7F,48,41,/i,eS,ab,FB,1E,h_,ef,rr,rc,di,b.,ol,im,eg,ap,_l,Se,19,oS,ew,bs,Su,F5,Co,BC,ud,C1,r-,ia,_o,65,.r,sk,o_,ck,CD,Am,9F,un,fa,F6,5F,nk,lo,ev,/f,.t,sE,nO,a_,EN,E4,Di,AC,95,74,1_,1A,us,ly,ll,_b,SA,FC,69,5E,43,um,tT,OS,CE,87,7A,59,44,t-,bl,ad,Or,D5,A_,31,24,t/,ph,mm,f.,ag,RS,Of,It,FA,De,1D,/d,-k,lf,hr,gu,fy,D6,89,6F,4E,/k,w_,cu,br,TE,ST,R_,E8,/O'.split(','))

export const CLASSES: [RegExp, number][] = [[/\d/, 10], [/[A-Z]/, 26], [/[a-z]/, 26]]

// Above this the products below lose all precision, and a value this long
// that reached the generic rule is a blob, not a credential typed in.
export const MAX_JUDGED_LENGTH = 100

// `pass` only as a word of its own (`DB_PASS`, `smtp.pass`), so `passport`
// and `passenger` are not names; a camelCase `dbPass` is lost to the `i` flag.
export const SECRET_NAME = '(?:(?:api|access|auth|client|private|secret|signing|encryption|master|app|service)[_.-]?key|token|secret|passw(?:or)?d|passphrase|pass(?![a-z])|pwd|credential)'
