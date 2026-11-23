// Unit fixtures only. No sample numeric packet is preloaded in the page.
import {describe,it,expect} from 'vitest';
import {render,screen} from '@testing-library/react';
import ResearchDesk,{inspectDeskPacket} from './ResearchDesk';
describe('Research Desk local inspector',()=>{
 it('starts empty, with no authenticated result or purchase button',()=>{render(<ResearchDesk/>);expect(screen.getByText('Bring your research packet')).toBeInTheDocument();expect(screen.getByText(/No wallet, payment, upload or live verification/)).toBeInTheDocument();expect(screen.queryByText(/FILE-REPORTED READY/)).toBeNull();});
 it('rejects mainnet and wrong format',()=>{expect(()=>inspectDeskPacket(JSON.stringify({version:'research-desk-v1',spec:{network:'eip155:1'}}))).toThrow();expect(()=>inspectDeskPacket('{}')).toThrow();});
 it('reads claimed fields as display only',()=>{const p={version:'research-desk-v1',spec:{network:'eip155:11155111',question:'UNIT FIXTURE',facts:[],assumptions:[]},observations:[],calculations:{},claim_results:{},accounting:{},reasons:[],outcome:'READY'};expect(inspectDeskPacket(JSON.stringify(p)).outcome).toBe('READY');});
 it('does not guess when duplicate fact observations exist',()=>{const p={version:'research-desk-v1',spec:{network:'eip155:11155111',facts:[{id:'unit'}],assumptions:[]},observations:[{fact_id:'unit',value:'1'},{fact_id:'unit',value:'2'}],calculations:{},claim_results:{},accounting:{},reasons:[]};expect(inspectDeskPacket(JSON.stringify(p)).facts[0].observation).toEqual({});});
 it('bounds rows before rendering',()=>{expect(()=>inspectDeskPacket(JSON.stringify({version:'research-desk-v1',spec:{network:'eip155:11155111',facts:Array.from({length:17},()=>({})),assumptions:[]},observations:[]}))).toThrow();});
});
