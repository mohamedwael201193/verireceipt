import {describe,it,expect} from 'vitest';
import {render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import Try from './Try';
import {SEPOLIA_REGISTRATION_ID, SEPOLIA_YAML_HASH} from '../lib/minerRegistration';

const renderPage=()=>render(<MemoryRouter><Try/></MemoryRouter>);

describe('Try the miner page',()=>{
 it('renders the five rubric steps in order',()=>{
  renderPage();
  for(const h of ['Run it','Check it','Inspect it','Break it','Reproduce it']) expect(screen.getByText(h)).toBeInTheDocument();
 });
 it('states free read-only scope and testnet framing',()=>{
  renderPage();
  expect(screen.getByText(/No wallet, payment or signup/)).toBeInTheDocument();
  expect(screen.getAllByText(/Sepolia testnet/i).length).toBeGreaterThan(0);
 });
 it('shows registration facts from the pinned constants',()=>{
  renderPage();
  expect(screen.getByText(new RegExp(String(SEPOLIA_REGISTRATION_ID)))).toBeInTheDocument();
  expect(screen.getByText(new RegExp(SEPOLIA_YAML_HASH.slice(0,20)))).toBeInTheDocument();
 });
 it('links the live health endpoint and the node miner record',()=>{
  renderPage();
  expect(screen.getByText('GET /health').closest('a')?.getAttribute('href')).toBe('https://verireceipt.onrender.com/health');
  expect(screen.getByText('node record').closest('a')?.getAttribute('href')).toBe(`https://devnode.telegraphprotocol.com/api/miners/${SEPOLIA_REGISTRATION_ID}`);
 });
 it('ships the two recorded-run replay commands with their real spec hashes',()=>{
  renderPage();
  expect(screen.getByText(/replay-desk-packet.ts b2-research-packet.json 0be670693eb9b00082ce07115f5a52f5368be88855f1f06ee6dd4d44cc36090f/)).toBeInTheDocument();
  expect(screen.getByText(/replay-desk-packet.ts b3-research-packet.json edd3e3e17a84cbc2fa29d13731b48c8d6be5c12c8964ea534f2e0cc5d245e433/)).toBeInTheDocument();
 });
 it('uses no numbered track references',()=>{
  const {container}=renderPage();
  expect(container.textContent).not.toMatch(/tracks?\s*[0-9]/i);
 });
 it('points the false-claim break at the desk control',()=>{
  renderPage();
  expect(screen.getByText('Open the NOT_SUPPORTED control').closest('a')?.getAttribute('href')).toBe('/research/desk');
 });
});
