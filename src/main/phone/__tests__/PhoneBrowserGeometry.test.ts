import { describe, expect, it } from 'vitest';
import { phoneBrowserGeometry, phoneBrowserPoint } from '../PhoneBrowserGeometry';

const geometry = {width:1000,height:728,scrollX:0,scrollY:100};
describe('phone screenshot coordinate mapping', () => {
  it('maps normalized image positions independently of JPEG scale and screen density', () => {
    expect(phoneBrowserPoint(0.5,0.25,geometry,geometry)).toEqual({x:500,y:182});
    const mobile = {...geometry,width:390,height:844};
    expect(phoneBrowserPoint(0.5,0.25,mobile,mobile)).toEqual({x:195,y:211});
  });
  it.each(['width','height','scrollX','scrollY'] as const)('rejects changed %s', field => {
    expect(() => phoneBrowserPoint(0.5,0.5,geometry,{...geometry,[field]:geometry[field]+1})).toThrow('viewport changed');
  });
  it.each([-1,1,NaN,Infinity,'0.5',null])('rejects an invalid normalized coordinate %s', x => {
    expect(() => phoneBrowserPoint(x,0.5,geometry,geometry)).toThrow('Invalid');
  });
  it('rejects unsupported pinch zoom, invalid sizes and failed probes', () => {
    const response = (value:unknown) => ({id:'probe',ok:true as const,result:{value}});
    expect(phoneBrowserGeometry(response({...geometry,scale:1}))).toEqual(geometry);
    expect(() => phoneBrowserGeometry(response({...geometry,scale:2}))).toThrow('Unsupported');
    expect(() => phoneBrowserGeometry(response({...geometry,scale:1,width:0}))).toThrow('Unsupported');
    expect(() => phoneBrowserGeometry({id:'probe',ok:false,error:'failed'})).toThrow('unavailable');
  });
});
