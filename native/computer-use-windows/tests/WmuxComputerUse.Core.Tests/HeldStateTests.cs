using System.Text;
using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class HeldStateTests
{
    private static byte[] B(string s) => Encoding.UTF8.GetBytes(s);

    [Fact]
    public void RoundTrips()
    {
        var state = new HeldState(4812, 133_700_000_000_000_000, [Keys.VkLControl, (ushort)'A'], [new HeldButton(0, 10.5, -20)]);
        var parsed = HeldState.Parse(state.Serialize(), 4812)!;
        Assert.Equal(state.Pid, parsed.Pid);
        Assert.Equal(state.Created, parsed.Created);
        Assert.Equal(state.Keys, parsed.Keys);
        Assert.Equal(state.Buttons, parsed.Buttons);
    }

    [Fact]
    public void RefusesAnotherPidOrMalformedFiles()
    {
        Assert.Null(HeldState.Parse(B("""{"pid":1,"created":5,"keys":[65]}"""), 2));
        Assert.Null(HeldState.Parse(B("""{"created":5,"keys":[65]}"""), 1));
        Assert.Null(HeldState.Parse(B("""{"pid":1,"keys":[65]}"""), 1));
        Assert.Null(HeldState.Parse(B("[1,2,3]"), 1));
        Assert.Null(HeldState.Parse(B("not json"), 1));
        Assert.Null(HeldState.Parse(B(""), 1));
        Assert.Null(HeldState.Parse(B("""{"pid":1,"created":5}"""), 0));
    }

    [Fact]
    public void RefusesOversizedFiles()
    {
        var big = """{"pid":1,"created":5,"keys":[""" + string.Join(",", Enumerable.Repeat("65", 2000)) + "]}";
        Assert.True(big.Length > HeldState.MaxFileBytes);
        Assert.Null(HeldState.Parse(B(big), 1));
    }

    [Fact]
    public void KeepsOnlyPressableKeys()
    {
        var parsed = HeldState.Parse(B("""{"pid":7,"created":1,"keys":[65,65,162,91,45,0,-3,256,999999,"x",1.5,92,232,13]}"""), 7)!;
        Assert.Equal([(ushort)65, (ushort)162, (ushort)91, (ushort)13], parsed.Keys);
    }

    [Fact]
    public void KeepsOnlyValidButtons()
    {
        var parsed = HeldState.Parse(B("""
            {"pid":7,"created":1,"buttons":[
              {"button":0,"x":1,"y":2},
              {"button":3,"x":1,"y":2},
              {"button":-1,"x":1,"y":2},
              {"button":1,"x":"NaN","y":2},
              {"button":1,"x":1e300,"y":2},
              {"button":2},
              {"button":0,"x":5,"y":5},
              {"button":2,"x":-100,"y":30}
            ]}
            """), 7)!;
        Assert.Equal([new HeldButton(0, 1, 2), new HeldButton(2, -100, 30)], parsed.Buttons);
    }

    [Fact]
    public void PidFromFileName()
    {
        Assert.Equal(4812, HeldState.PidFromFileName("4812.json"));
        Assert.Null(HeldState.PidFromFileName("4812.json.tmp"));
        Assert.Null(HeldState.PidFromFileName("..json"));
        Assert.Null(HeldState.PidFromFileName("-1.json"));
        Assert.Null(HeldState.PidFromFileName("0.json"));
        Assert.Null(HeldState.PidFromFileName("12345678901.json"));
        Assert.Null(HeldState.PidFromFileName("abc.json"));
    }
}
