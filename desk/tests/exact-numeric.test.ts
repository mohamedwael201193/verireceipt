import {it,expect} from 'vitest';
import {exactNumericEqual} from '../src/exactNumeric.js';
it('normalizes only exact same decimal rational',()=>{for(const [a,b] of [[1000000000,'1000000000'],['1.000','1'],['-0',0],[0.125,'0.125']])expect(exactNumericEqual(a,b)).toBe(true);});
it('does not allow rounding, unit conversion or missing placeholders',()=>{for(const [a,b] of [[3110285426.77,3110285426.7703633],[1,'100'],[null,0],[undefined,0],['1e3',1000],[' 1',1],['Infinity',Infinity],['01',1],['NaN',NaN]])expect(exactNumericEqual(a,b)).toBe(false);});
