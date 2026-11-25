// Unit fixtures only. No packet result is preloaded; recorded-run examples load only on click.
import {describe,it,expect} from 'vitest';
import {render,screen} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import ResearchDesk,{inspectDeskPacket} from './ResearchDesk';
describe('Research Desk local inspector',()=>{
 it('starts empty, with no authenticated result or purchase button',()=>{render(<ResearchDesk/>);expect(screen.getByText('Bring your research packet')).toBeInTheDocument();expect(screen.getByText(/No wallet, payment, upload or live verification/)).toBeInTheDocument();expect(screen.queryByText(/FILE-REPORTED READY/)).toBeNull();});
 it('rejects mainnet and wrong format',()=>{expect(()=>inspectDeskPacket(JSON.stringify({version:'research-desk-v1',spec:{network:'eip155:1'}}))).toThrow();expect(()=>inspectDeskPacket('{}')).toThrow();});
 it('reads claimed fields as display only',()=>{const p={version:'research-desk-v1',spec:{network:'eip155:11155111',question:'UNIT FIXTURE',facts:[],assumptions:[]},observations:[],expenses:[],calculations:{},claim_results:{},accounting:{},reasons:[],outcome:'READY'};expect(inspectDeskPacket(JSON.stringify(p)).outcome).toBe('READY');});
 it('does not guess when duplicate fact observations exist',()=>{const p={version:'research-desk-v1',spec:{network:'eip155:11155111',facts:[{id:'unit'}],assumptions:[]},observations:[{fact_id:'unit',value:'1'},{fact_id:'unit',value:'2'}],expenses:[],calculations:{},claim_results:{},accounting:{},reasons:[]};expect(inspectDeskPacket(JSON.stringify(p)).facts[0].observation).toEqual({});});
 it('bounds rows before rendering',()=>{expect(()=>inspectDeskPacket(JSON.stringify({version:'research-desk-v1',spec:{network:'eip155:11155111',facts:Array.from({length:17},()=>({})),assumptions:[]},observations:[]}))).toThrow();});
});


it('retains failed-attempt exposure on withheld fact cards',()=>{const p={version:'research-desk-v1',spec:{network:'eip155:11155111',facts:[{id:'tvl'}],assumptions:[]},observations:[],expenses:[{fact_id:'tvl',reserved_uusdc:'10000',settled_uusdc:null,status:'receipted-unsettled',receipt_hash:'unit'}],calculations:{},claim_results:{},accounting:{},reasons:[],outcome:'HOLD'};const v=inspectDeskPacket(JSON.stringify(p));expect(v.facts[0].exposure).toBe('10000');expect(v.facts[0].observation).toEqual({});});

it('discloses auto-route fallback without claiming a live ranking check',()=>{render(<ResearchDesk/>);expect(screen.getByText(/Client-ranked direct selection and provider escalation are not enabled/)).toBeInTheDocument();expect(screen.getByText(/does not fetch live rankings/)).toBeInTheDocument();});

it('discloses the run C2 provenance plainly',()=>{render(<ResearchDesk/>);expect(screen.getByText(/not a live READY run/)).toBeInTheDocument();expect(screen.getByText(/13:52:55Z/)).toBeInTheDocument();expect(screen.getByText(/No second payment/)).toBeInTheDocument();expect(screen.getByText(/byte-identical to the recorded run.s stored observations/)).toBeInTheDocument();});

it('labels contract valuation without claiming aggregate FDV',()=>{render(<ResearchDesk/>);expect(screen.getByText(/Ethereum-contract implied valuation, not aggregate economic FDV/)).toBeInTheDocument();});

it('offers the recorded-run examples without preloading any result',()=>{render(<ResearchDesk/>);expect(screen.getByText('Open the READY packet')).toBeInTheDocument();expect(screen.getByText('Open the NOT_SUPPORTED control')).toBeInTheDocument();const b2=screen.getByText('Download B2');expect(b2.getAttribute('href')).toBe('/packets/b2-research-packet.json');expect(b2.getAttribute('download')).toBe('b2-research-packet.json');expect(screen.queryByText(/FILE-REPORTED READY/)).toBeNull();});

it('inspects the shipped recorded packets end to end',()=>{const read=(n:string)=>readFileSync(new URL('../../public/packets/'+n,import.meta.url),'utf8');const b2=inspectDeskPacket(read('b2-research-packet.json'));expect(b2.outcome).toBe('READY');expect(b2.claims.every(c=>c.status==='SUPPORTED')).toBe(true);const b3=inspectDeskPacket(read('b3-research-packet.json'));expect(b3.outcome).toBe('READY');expect(b3.claims.find(c=>c.id==='filing_threshold')?.status).toBe('NOT_SUPPORTED');});
