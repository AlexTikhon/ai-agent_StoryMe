import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPatchForReview } from './dist/src/review/patch.js';
import { runReviewPipeline } from './dist/src/review/pipeline.js';
import { resultExitCode } from './dist/src/cli/output.js';
import { ModelError } from './dist/src/model/types.js';
import { chunkSource } from './dist/src/retrieval/chunker.js';
import { retrieveContext } from './dist/src/retrieval/retrieve.js';
import { CHUNKER_VERSION } from './dist/src/retrieval/types.js';
import { buildRepositoryIndex, loadIndex, indexPath } from './dist/src/retrieval/index-store.js';
import { ignoreFromTrustedContents } from './dist/src/review/filter.js';
import { isMandatorySensitivePath } from './dist/src/privacy/policy.js';

globalThis.fetch = async () => { throw new Error('Network disabled in audit reproductions'); };
const args={reviewMode:'local',format:'json',dryRun:false,indexOnly:false,allowExternal:false,contextMode:'diff',severityThreshold:'high',help:false};
const config={model:'mock',embeddingModel:'mock',allowExternal:false,allowEmbeddings:false,maxInputTokens:8000,maxOutputTokens:200,maxMetadataCharacters:500,maxPatchTokens:1000,maxContextTokens:1000,maxSegmentsPerFile:10,maxFiles:10,maxRequests:10,concurrency:1,requestTimeoutMs:1000,totalTimeoutMs:5000,maxAttempts:1,retrievalCandidates:20,retrievalTopK:5,relevanceThreshold:0,cacheDirName:'.audit-cache'};
const file=(filename,patch='@@ -0,0 +1 @@\n+safe()')=>({filename,status:'modified',additions:1,deletions:0,changes:1,patch});
const source=(files)=>({mode:'local',title:'synthetic',description:'',repositoryId:'r',baseRevision:'base',headRevision:'head',snapshotId:'snap',files,coverageComplete:true});
const clean=()=>({response:{findings:[],summary:'No issue',abstained:false,abstentionReason:null},usage:{inputTokens:1,outputTokens:1,actual:true}});
const model={provider:'mock',review:async()=>clean()};

const limited=await runReviewPipeline(args,{config:{...config,maxFiles:1},model,source:source([file('a.ts'),file('b.ts')])});
assert.equal(limited.status,'complete');
assert.equal(resultExitCode(limited,'high'),0);
assert.equal(limited.skippedFiles[0].reason,'work_limit');
console.log('CONFIRMED coverage: 2 eligible source files, maxFiles=1 => status=complete, exit=0, one work_limit omission.');
const missing=await runReviewPipeline(args,{config,model,source:source([file('a.ts'),file('b.ts',undefined)])});
// Explicitly remove the second patch because the helper supplies a default.
const missingSource=source([file('a.ts'),{...file('b.ts'),patch:undefined}]);
const missingResult=await runReviewPipeline(args,{config,model,source:missingSource});
assert.equal(missingResult.status,'complete');
console.log('CONFIRMED coverage: reviewed file plus missing textual patch => status=complete, exit='+resultExitCode(missingResult,'high'));

const patch='@@ -0,0 +100,30 @@\n'+Array.from({length:30},(_,i)=>'+'+`value_${100+i}=`+'x'.repeat(25)).join('\n');
const segments=splitPatchForReview(patch,100,100);
assert.ok(segments.length>1);
assert.ok(segments[1].lineRanges[0].start<100);
console.log('CONFIRMED line mapping: original additions start at 100; segment ranges='+JSON.stringify(segments.slice(0,3).map(s=>s.lineRanges)));

let calls=0;
const retryModel={provider:'mock',async review(){calls++;if(calls<3)throw new ModelError('temporary synthetic failure',true);return clean();}};
const retried=await runReviewPipeline(args,{config:{...config,maxRequests:1,maxAttempts:3},model:retryModel,source:source([file('a.ts')])});
assert.equal(calls,3);
console.log('CONFIRMED request budget: maxRequests=1 allowed '+calls+' provider attempts; status='+retried.status);

const parserInput='export function authorize(user) {\n const marker = "}";\n return user.admin;\n}';
const parsedChunks=chunkSource({repositoryId:'r',revision:'s',path:'auth.ts',content:parserInput,maxTokens:1000});
assert.ok(!parsedChunks.some(c=>c.content.includes('return user.admin')));
console.log('CONFIRMED chunker: closing brace inside a string makes security-relevant return line disappear from all chunks.');

const noise=chunkSource({repositoryId:'r',revision:'s',path:'noise.ts',content:'export function query() { return 0; }',maxTokens:1000})[0];
const relevant=chunkSource({repositoryId:'r',revision:'s',path:'relevant.ts',content:'export function target() { return 1; }',maxTokens:1000})[0];
const embedding={provider:'test',model:'fake',version:'v1',embed:async texts=>texts.map(()=>[1,0])};
const vectors={};
for (const [c,v] of [[noise,[0,1]],[relevant,[1,0]]]) {const key=`${c.contentHash}:fake:v1:${CHUNKER_VERSION}`;vectors[key]={cacheKey:key,values:v};}
const retrieval=await retrieveContext({index:{schemaVersion:1,chunkerVersion:CHUNKER_VERSION,repositoryId:'r',revision:'s',chunks:[noise,relevant],vectors},repositoryId:'r',revision:'s',query:'query',changedPath:'app.ts',mode:'hybrid',candidates:1,topK:1,threshold:0,embedding});
assert.equal(retrieval[0].chunk.path,'noise.ts');
console.log('CONFIRMED hybrid: semantically exact match outside lexical candidate shortlist cannot be retrieved.');

const fixture=await mkdtemp(join(tmpdir(),'acr-v2-audit-'));
const git=(...a)=>execFileSync('git',a,{cwd:fixture,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git('init');
await writeFile(join(fixture,'dependency.ts'),'export const dependency = "committed";\n');
git('add','dependency.ts');
git('-c','user.name=Offline audit','-c','user.email=audit@example.invalid','-c','commit.gpgsign=false','commit','-m','Synthetic fixture');
const sha=git('rev-parse','HEAD');
await writeFile(join(fixture,'dependency.ts'),'export const dependency = "DIRTY_LOCAL_NOT_IN_PR";\n');
const prSource={...source([file('app.ts')]),mode:'pr',repositoryRoot:fixture,headRevision:sha,snapshotId:'pr-snapshot'};
const indexed=await runReviewPipeline({...args,reviewMode:'pr',owner:'test',repo:'test',pullNumber:1,indexOnly:true,contextMode:'lexical'},{config,model,source:prSource});
const saved=await loadIndex(indexPath(fixture,config.cacheDirName));
assert.ok(saved.chunks.some(c=>c.content.includes('DIRTY_LOCAL_NOT_IN_PR')));
assert.ok(saved.chunks.every(c=>c.revision==='pr-snapshot'));
console.log('CONFIRMED PR revision: matching HEAD with dirty checkout indexes uncommitted content labeled as PR snapshot; status='+indexed.status);

let embeddedCount=0;
const cacheEmbedding={...embedding,async embed(texts){embeddedCount+=texts.length;return texts.map(()=>[1,0]);}};
const indexOptions={root:fixture,repositoryId:'r',revision:'v1',cacheDirName:'.vector-audit',maxChunkTokens:1000,ignorePolicy:ignoreFromTrustedContents(),embedding:cacheEmbedding};
await buildRepositoryIndex(indexOptions);
const firstCount=embeddedCount;
await rename(join(fixture,'dependency.ts'),join(fixture,'renamed.ts'));
await buildRepositoryIndex({...indexOptions,revision:'v2'});
assert.equal(embeddedCount,firstCount);
console.log('CONFIRMED vector cache: filename is part of embedding input, but rename reuses old vector because key omits path.');
await buildRepositoryIndex({...indexOptions,revision:'v3',embedding:undefined});
await buildRepositoryIndex({...indexOptions,revision:'v4'});
assert.ok(embeddedCount>firstCount);
console.log('CONFIRMED vector cache: lexical index rebuild removes cached vectors; next hybrid index re-embeds unchanged content.');

assert.equal(isMandatorySensitivePath('.ssh/config'),false);
assert.equal(isMandatorySensitivePath('.gnupg/settings.ts'),false);
console.log('CONFIRMED mandatory privacy: root .ssh/ and .gnupg/ descendants miss intended directory checks.');
console.log('Synthetic fixture retained for inspection: '+fixture);
