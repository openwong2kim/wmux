import { describe, expect, it } from 'vitest';
import { PhoneBrowserViewportChanged, phoneBrowserGeometry, phoneBrowserPoint, phoneBrowserScrollPoint } from '../PhoneBrowserGeometry';

const geometry = {width:1000,height:728,scrollX:0,scrollY:100};
describe('phone screenshot coordinate mapping', () => {
  it('maps normalized image positions independently of JPEG scale and screen density', () => {
    expect(phoneBrowserPoint(0.5,0.25,geometry,geometry)).toEqual({x:500,y:182});
    const mobile = {...geometry,width:390,height:844};
    expect(phoneBrowserPoint(0.5,0.25,mobile,mobile)).toEqual({x:195,y:211});
  });
  it.each(['width','height','scrollX','scrollY'] as const)('rejects changed %s', field => {
    expect(() => phoneBrowserPoint(0.5,0.5,geometry,{...geometry,[field]:geometry[field]+1})).toThrow('viewport changed');
    expect(() => phoneBrowserPoint(0.5,0.5,geometry,{...geometry,[field]:geometry[field]+1})).toThrow(PhoneBrowserViewportChanged);
  });
  it('a stream scroll checks the viewport size only, and scales the anchor by the size sent', () => {
    const scrolled = {...geometry,scrollX:7,scrollY:900};
    expect(phoneBrowserScrollPoint(0.5,0.25,geometry,scrolled)).toEqual({x:500,y:182});
    // The size sent need not carry scroll offsets at all.
    expect(phoneBrowserScrollPoint(0.5,0.25,{width:1000,height:728},scrolled)).toEqual({x:500,y:182});
    for (const field of ['width','height'] as const) {
      expect(() => phoneBrowserScrollPoint(0.5,0.5,geometry,{...geometry,[field]:geometry[field]+1})).toThrow(PhoneBrowserViewportChanged);
    }
    expect(() => phoneBrowserScrollPoint(1,0.5,geometry,geometry)).toThrow('Invalid');
    expect(() => phoneBrowserScrollPoint(1,0.5,geometry,geometry)).not.toThrow(PhoneBrowserViewportChanged);
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
