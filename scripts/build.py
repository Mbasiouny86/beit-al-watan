# usage: python3 build.py bw_refresh.json prev_live.json(or madinty doc) out.json
import json,re,sys,datetime,collections
src,prev,outp=sys.argv[1:4]
D=json.load(open(src));P=json.load(open(prev));P=P.get('data',P) if 'data' in P and isinstance(P['data'],dict) else P
now=D['now'];today=now[:10]
def N(s):
    s=str(s or '').replace('ٔ','')
    for a,b in [('أ','ا'),('إ','ا'),('آ','ا'),('ى','ي'),('ة','ه')]: s=s.replace(a,b)
    return re.sub(r'[\s\-\(\)_\.]','',s.translate(str.maketrans('٠١٢٣٤٥٦٧٨٩','0123456789')))
# recent bookings -> daily docs + today/wk per city|zone
rec=collections.defaultdict(lambda:collections.defaultdict(list));agg=collections.defaultdict(lambda:[0,0])
wk0=(datetime.date.fromisoformat(today)-datetime.timedelta(days=6)).isoformat()
# Daily counts = real session bookings only. Drop bulk batches the site inserts as pre-reserved:
# >=20 plots of one zone stamped in the same minute (real sessions peak ~11/zone/minute, even on the 809-booking day),
# plus that zone's records within 1 minute of such a batch.
def _m(t):return int(datetime.datetime.fromisoformat(t).timestamp()//60)
zm=collections.Counter((r[3],_m(r[0])) for r in D['R'])
hot={k for k,v in zm.items() if v>=20}
# zones that first appear already fully reserved (no free plots) are bulk inserts too
pm=set(P.get('meta',{}).keys());newfull={z[0] for z in D['Z'] if pm and str(z[0]) not in pm and not z[6]}|set(P.get('bulkZones',[]))
bulkI=set();bulk=collections.defaultdict(lambda:collections.Counter())
for i,r in enumerate(D['R']):
    m=_m(r[0])
    if r[3] in newfull or any((r[3],m+o) in hot for o in (-1,0,1)):
        bulkI.add(i);bulk[r[0][:10]][f'{r[1]} | {r[2]}']+=1
for i,(t,c,z,zid,n,a,p) in enumerate(D['R']):
    if i in bulkI: continue
    d=t[:10];rec[d][(c,z,zid)].append(f'{n}:{a:g}:{p:g}:{t[11:16]}')
    k=N(c)+'|'+N(z)
    if d>=wk0: agg[k][1]+=1
    if d==today: agg[k][0]+=1
dates=sorted(rec);oldest=dates[0] if dates else today
recent={}
for d in dates[1:] if len(dates)>1 else dates:   # first date may be partial -> skip it
    zs=rec[d];recent[d]={'date':d,'n':sum(len(v) for v in zs.values()),'zones':[{'c':c,'z':z,'id':zid,'n':len(v),'p':';'.join(sorted(v,key=lambda x:x[-5:]))} for (c,z,zid),v in sorted(zs.items(),key=lambda kv:-len(kv[1]))]}
# zones (madinty format) aggregated by city|zone
Z=collections.OrderedDict();meta={}
for zid,loc,c,z,base,tot,av,res,amin,amax,dmin,dmax,br,fl in D['Z']:
    meta[str(zid)]=[loc,c,z,base]
    if not tot: continue
    k=N(c)+'|'+N(z);o=Z.get(k)
    if not o: Z[k]=dict(c=c,z=z,ppm=base,tot=tot,av=av,res=res,amin=amin,amax=amax,dpmin=dmin,dpmax=dmax,br=br,fl=fl,today=agg[k][0],wk=agg[k][1])
    else:
        for f in ('tot','av','res'): o[f]+=locals()[f]
        o['amin']=min(o['amin'],amin);o['amax']=max(o['amax'],amax);o['dpmin']=min(o['dpmin'],dmin);o['dpmax']=max(o['dpmax'],dmax)
days=dict(P.get('days',{}))
for d,v in recent.items(): days[d]=v['n']
days[today]=len(rec[today]) and sum(len(v) for v in rec[today].values())  # resets to 0 at each new day
for d,b in bulk.items():
    if d in recent: recent[d]['bulk']=sum(b.values())
st=D['stats'];offered=sum(x[5] for x in D['Z'])
# NUCA news -> serial info
L=[x for x in D['news'] if x not in ('قائمة الأخبار','انتظر قليلا...','...')]
items=[];i=0
while i<len(L):
    if i+1<len(L) and re.fullmatch(r'\d{2}-\d{2}-\d{4}',L[i+1]):
        items.append({'title':L[i],'d':L[i+1],'body':L[i+2] if i+2<len(L) and not re.fullmatch(r'\d{2}-\d{2}-\d{4}',L[i+2]) else ''});i+=2
    else:i+=1
nuca=dict(P.get('nuca',{}))
def ad(s):d,m,y=s.split('-');return f'{y}-{m}-{d}'
for it in reversed(items):  # oldest -> newest
    tx=it['title']+' '+it['body'];tx=tx.translate(str.maketrans('٠١٢٣٤٥٦٧٨٩','0123456789'))
    m=re.search(r'حت[يى] مسلسل\s*(\d{3,6})',tx);r=re.search(r'من مسلسل\s*(\d{3,6})\s*(?:حت[يى]|الى|إلى)\s*(?:مسلسل)?\s*(\d{3,6})',tx) or re.search(r'بد[ءا]+\s*(\d{3,6})\s*حت[يى]\s*(\d{3,6})',tx)
    if 'الانتهاء' in tx and m: nuca['servedTo']=max(nuca.get('servedTo',0),int(m.group(1)))
    if r:
        a,b=int(r.group(1)),int(r.group(2));eff=ad(it['d'])
        dm=re.search(r'(\d{4})/(\d{1,2})/(\d{1,2})',tx)
        if dm: eff=f'{dm.group(1)}-{int(dm.group(2)):02d}-{int(dm.group(3)):02d}'
        elif 'غدا' in tx: eff=(datetime.date.fromisoformat(eff)+datetime.timedelta(days=1)).isoformat()
        sched=nuca.setdefault('sched',{});sched[eff]=b-a+1;nuca['perDay']=b-a+1
        if eff<today or (eff==today and now[11:13]>='10'):
            nuca['calledTo']=max(nuca.get('calledTo',0),b);nuca['servedTo']=max(nuca.get('servedTo',0),a-1)
            nuca['nextNote']=f'{eff}: serials {a:,}–{b:,} ({b-a+1} that day)'
        else: nuca['nextNote']=f'Next: {eff} from serial {a:,} to {b:,} ({b-a+1})'
if D.get('nz'):
    zn=dict(P.get('nuca',{}).get('zn',{}));zn.update({str(k):v for k,v in D['nz'].items()});nuca['zn']=zn
    zb=dict(P.get('nuca',{}).get('zb',{}));zb.update({str(k):v for k,v in D.get('nb',{}).items()});nuca['zb']=zb
    nuca['zts']=D.get('nzts') or now
    zm=dict(P.get('nuca',{}).get('zm',{}));zm.update({str(k):v for k,v in (D.get('nzm') or {}).items()});nuca['zm']=zm
    nuca['zdone']=f"{len(D['nz'])}/{D.get('nzN')}"
nuca['news']=[{'d':it['d'],'ar':(it['title']+(' — '+it['body'] if it['body'] and it['body']!=it['title'] else ''))[:300]} for it in items[:6]]
live={'date':today,'ts':now,'source':'madintyegy.com API + NUCA news (auto refresh)','totals':{'offered':offered,'reserved':st['total_reserved_count'],'available':offered-st['total_reserved_count'],'sold':0},
 'days':days,'zones':list(Z.values()),'S':D['S'],'meta':meta,'recent':recent,'nuca':nuca,'bulk':{d:dict(b) for d,b in sorted({**P.get('bulk',{}),**bulk}.items())},'bulkZones':sorted(newfull)}
json.dump(live,open(outp,'w'),ensure_ascii=False)
print(json.dumps({'ts':now,'reserved':st['total_reserved_count'],'today':days.get(today),'free':live['totals']['available'],'nuca':{k:v for k,v in nuca.items() if k not in('news','zn','zb','zm')},'nucaFree':sum(nuca.get('zn',{}).values()),'nucaZones':nuca.get('zdone'),'nucaTs':nuca.get('zts'),'size':len(json.dumps(live,ensure_ascii=False).encode())},ensure_ascii=False))
