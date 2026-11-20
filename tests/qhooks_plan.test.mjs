import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {contractCases,contractRead,contractAttacks}=require('./contract-fixture.cjs');
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
const markdown=await readFile(new URL('../skills/wallet-mcp/plugins/qhooks.md',import.meta.url),'utf8');
const source=markdown.match(/```javascript\n([\s\S]*?)\n```/)[1];
const context=vm.createContext({crypto:webcrypto,TextEncoder});
vm.runInContext(source+'\nglobalThis.mapper=qhooksCalls;',context,{timeout:1000});
const independentFor=new WeakMap();
const rawMap=context.mapper, map=(p,i,w,n)=>rawMap(p,i,w,n,independentFor.get(p)), wallet='0x1111111111111111111111111111111111111111',token='0x2222222222222222222222222222222222222222',attacker='0x4444444444444444444444444444444444444444';
const zero='0x'+'0'.repeat(40),router='0x79d211f5137d22b0fe3bfda81fbb8b7f53248bff',now=2000000000;
const managers={'1':'0x000000000004444c5dc75cb358380d2e3de08a90','8453':'0x498581ff718922c3f8e6a244956af099b2652b2b','42161':'0x360e68faccca8ca495c1b759fd9eee466db9fb32','56':'0x28e2ea090877bf75740558f6bfb36a5ffee9e9df','4663':'0x8366a39cc670b4001a1121b8f6a443a643e40951'};
const word=value=>BigInt(value).toString(16).padStart(64,'0');
function seal(p){p.integrity={schema:'qhooks.trade-plan.v1',algorithm:'sha256',hash:'0x'+createHash('sha256').update(JSON.stringify(['qhooks.trade-plan.v1',p.chainId,p.trader,p.transactions.map(t=>[String(t.chainId),t.to.toLowerCase(),t.data.toLowerCase(),BigInt(t.value).toString(),t.from??null])])).digest('hex')};return p;}
function fixture({chain='4663',native=true,side='buy'}={}){
 const q=native?zero:'0x1000000000000000000000000000000000000000',input=side==='buy'?q:token,output=side==='buy'?token:q,direction=BigInt(input)<BigInt(output),amount=100000n,gross=100000n,net=side==='buy'?gross:gross-gross/100n,minimum=net*9900n/10000n;
 const p={chain,chainId:chain,trader:wallet,token,side,inputCurrency:input,amountIn:String(amount),minOut:String(minimum),slippageBps:100,deadline:now+600,transactions:[],quote:{poolId:'0x'+'3'.repeat(64),chainId:chain,trader:wallet,source:'V4Quoter',routerFeeBps:100,zeroForOne:direction,amountIn:String(side==='buy'?amount-amount/100n:amount),amountOut:String(gross),grossAmountOut:String(gross),netAmountOut:String(net)}};
 if(input!==zero)p.transactions.push({chainId:chain,to:input,data:'0x095ea7b3'+word(router)+word(amount),value:'0'});
 const currencies=direction?[input,output]:[output,input];const words=[managers[chain],288,amount,minimum,zero,side==='buy'?1:0,100,p.deadline,zero,1,32,...currencies,3000,60,zero,direction?1:0,224,0];
 p.transactions.push({chainId:chain,to:router,data:'0xf5ec7c4b'+words.map(word).join(''),value:input===zero?String(amount):'0'});seal(p);independentFor.set(p,readFor(structuredClone(p)));return p;
}
function readFor(p){
 const w=p.transactions.at(-1).data.slice(10).match(/.{64}/g),a=i=>'0x'+w[i].slice(24);
 return async(name,args)=>name==='token_info'?{meta:{chainId:p.chain,token,pools:[{label:'launch',id:p.quote.poolId,key:{currency0:a(11),currency1:a(12),fee:3000,tickSpacing:60,hooks:a(15)}}]}}:name==='quote'?p.quote:contractRead(name,args);
}
const intent=p=>({tool:'prepare_trade',arguments:{chain:p.chain,token,side:p.side,trader:wallet,amountIn:p.amountIn,slippageBps:100}});
function change(tx,index,value){const i=10+index*64;tx.data=tx.data.slice(0,i)+word(value)+tx.data.slice(i+64);}
const reject=p=>assert.rejects(map(p,intent(p),wallet,now));

test('actual markdown mapper handles five supported chains, native/ERC20 and buy/sell',async()=>{
 for(const chain of Object.keys(managers))for(const native of [true,false])for(const side of ['buy','sell']){
  const p=fixture({chain,native,side});const out=await map(p,intent(p),wallet,now);assert.equal(out.calls.length,p.transactions.length);assert.equal(out.calls.at(-1).to,router);assert.deepEqual(Object.keys(out.calls[0]).sort(),['data','to','value']);
 }
});
test('review tampered-plan proof: unlimited approval and5ETH attacker transfer are refused',async()=>{
 const p=fixture({native:false});p.transactions[0].to=attacker;change(p.transactions[0],0,attacker);change(p.transactions[0],1,(1n<<256n)-1n);p.transactions.push({chainId:p.chain,to:attacker,data:'0x',value:'5000000000000000000'});await reject(seal(p));
});
test('independent checks reject rehashed wrong approval, sender, chain and swap fields',async()=>{
 const edits=[p=>change(p.transactions[0],0,attacker),p=>change(p.transactions[0],1,1),p=>p.transactions[0].chainId='8453',p=>p.transactions[0].from=attacker,p=>p.quote.trader=attacker,p=>change(p.transactions.at(-1),2,1),p=>change(p.transactions.at(-1),3,1),p=>change(p.transactions.at(-1),0,attacker),p=>change(p.transactions.at(-1),8,attacker),p=>p.transactions.at(-1).value='1',p=>p.transactions[0].authorizationList=[]];
 for(const edit of edits){const p=fixture({native:false});edit(p);await reject(seal(p));}
});
test('trade source cannot be downgraded by changing the response shape or actor',async()=>{
 const p=fixture(),original=intent(p);delete p.side;delete p.token;delete p.trader;await assert.rejects(map(p,original,wallet,now));
 const changed=fixture();await assert.rejects(map(changed,{...intent(changed),arguments:{...intent(changed).arguments,trader:attacker}},wallet,now));
 await assert.rejects(map(fixture(),null,wallet,now));
});
test('missing hash or per-transaction chain fails closed; digest is not a signature',async()=>{
 const p=fixture();delete p.integrity;await reject(p);const q=fixture();delete q.transactions[0].chainId;await reject(seal(q));
 const isolated=vm.createContext({TextEncoder});vm.runInContext(source+'\nglobalThis.mapper=qhooksCalls;',isolated);const valid=fixture();await assert.rejects(isolated.mapper(valid,intent(valid),wallet,now));
});
test('OTC/agreement exact approvals and actions pin contract, token, amount and RH chain',async()=>{
 for(const c of contractCases()){
  const i={tool:c.tool,arguments:c.input};const out=await rawMap(c.plan,i,wallet,now,contractRead);assert.equal(out.calls.length,(c.plan.transactions??c.plan.txs).length);
  for(const bad of contractAttacks(c))await assert.rejects(rawMap(bad.plan,{tool:bad.tool,arguments:bad.input},wallet,now,contractRead),bad.name);
 }
});
test('independent pool key and net quote reject each rehashed review proof',async()=>{
 for(const edit of [p=>change(p.transactions.at(-1),15,attacker),p=>change(p.transactions.at(-1),13,500),p=>change(p.transactions.at(-1),14,200),p=>{for(const k of ['amountOut','grossAmountOut','netAmountOut'])p.quote[k]='50000';p.minOut='49500';change(p.transactions.at(-1),3,49500);}]){const p=fixture();edit(p);await reject(seal(p));}
 const p=fixture();await assert.rejects(rawMap(p,intent(p),wallet,now));
});
test('launch links, perps, unsupported chains and unknown outcomes do not become Wallet MCP calls',async()=>{
 const p=fixture();for(const tool of ['prepare_launch','prepare_perps_order','unknown'])await assert.rejects(map(p,{tool,arguments:{}},wallet,now));
 p.chain='99901';p.chainId='99901';await reject(seal(p));const unknown=fixture();unknown.status='unknown';await reject(unknown);
});
